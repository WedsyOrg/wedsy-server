/**
 * controllers/venueRoomTypes.js — the room TYPE as a real entity, and the
 * venue's room-amenities library.
 *
 * Every write that can change what a type says, what rooms belong to it, or
 * which rooms are active re-derives the couple-facing accommodation block
 * through utils/venueRoomTypes.projectAccommodation. There is no second place
 * that block is written from.
 *
 * Scope: same shape as controllers/venueRooms.js — reads open to any
 * authenticated venue identity, writes gated on the `listing` capability at the
 * route.
 */
const Venue = require("../models/Venue");
const { reqStr, optStr, optNumber, optCount } = require("../utils/venueInput");
const {
  DEFAULT_ROOM_AMENITIES,
  INHERITABLE_FIELDS,
  AMENITY_GROUPS,
  amenityKeyFor,
  amenityUsage,
  resolveGroup,
  applyTypeToRooms,
  projectAccommodation,
  resolveRooms,
} = require("../utils/venueRoomTypes");
const { resolvePolicy, includedRooms, quoteRooms } = require("../utils/venueRoomsPolicy");
const { decorateDeletability } = require("../utils/venueRoomDeletion");

// `blocks` is in here because validatePlacement and resolveLayout read it, and
// a select that omits it does not fail loudly — it makes every block look
// absent, so a correct guard refuses a placement that was perfectly valid. That
// is the shape of bug this repo has been bitten by before: the guard is right,
// the arguments it was given are not.
const SELECT = "_id slug rooms roomTypes roomAmenities accommodation blocks roomsPolicy";

async function resolveOwnedVenue(req, res, select = SELECT) {
  const venue = await Venue.findOne({ slug: req.params.slug }).select(select);
  if (!venue) { res.status(404).json({ message: "Venue not found" }); return null; }
  if (String(venue._id) !== String(req.venueOwner.venueId)) { res.status(403).json({ message: "Forbidden" }); return null; }
  return venue;
}

/** Amenity keys must resolve against this venue's library — no free text. */
function validateAmenityKeys(venue, raw, field = "amenities") {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(raw)) return { ok: false, message: `${field} must be a list` };
  const known = new Map((venue.roomAmenities || []).map((a) => [String(a.key), a]));
  const out = [];
  for (const k of raw) {
    const key = String(k || "").trim();
    if (!key) continue;
    const found = known.get(key);
    if (!found) return { ok: false, message: `"${key}" is not in this venue's amenity list. Add it there first.` };
    if (found.isActive === false) return { ok: false, message: `"${found.label}" has been removed from the amenity list.` };
    if (!out.includes(key)) out.push(key);
  }
  return { ok: true, value: out };
}

function validateTypeInput(venue, body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.name !== undefined) {
    const v = reqStr(body.name, "name", 200);
    if (!v.ok) return { error: v.message };
    out.name = v.value;
  }
  if (body.sleeps !== undefined) {
    const v = optCount(body.sleeps, "sleeps", { max: 200 });
    if (!v.ok) return { error: v.message };
    if (v.value !== undefined) {
      if (v.value < 1) return { error: "sleeps must be at least 1" };
      out.sleeps = v.value;
    }
  }
  if (body.maxOccupancy !== undefined) {
    const v = optCount(body.maxOccupancy, "maxOccupancy", { max: 200 });
    if (!v.ok) return { error: v.message };
    if (v.value !== undefined) out.maxOccupancy = v.value;
  }
  if (body.defaultRate !== undefined) {
    const v = optNumber(body.defaultRate, "defaultRate", { max: 1e9 });
    if (!v.ok) return { error: v.message };
    if (v.value !== undefined) out.defaultRate = v.value;
  }
  if (body.description !== undefined) {
    const v = optStr(body.description, "description", 2000);
    if (!v.ok) return { error: v.message };
    out.description = v.value;
  }
  // ── ROOMS 4: WHAT A COUPLE DECIDES ON ────────────────────────────────────
  // All optional. Stored exactly as typed apart from trimming, because these
  // are read by a couple in the owner's own words — see the model for why beds
  // and view are free text rather than lists we invented.
  if (body.sizeSqFt !== undefined) {
    const v = optCount(body.sizeSqFt, "sizeSqFt", { max: 100000 });
    if (!v.ok) return { error: v.message };
    if (v.value !== undefined) out.sizeSqFt = v.value;
  }
  if (body.bedConfiguration !== undefined) {
    const v = optStr(body.bedConfiguration, "bed configuration", 200);
    if (!v.ok) return { error: v.message };
    out.bedConfiguration = v.value;
  }
  if (body.view !== undefined) {
    const v = optStr(body.view, "view", 120);
    if (!v.ok) return { error: v.message };
    out.view = v.value;
  }
  // ── ROOMS 6: two tri-state fields ────────────────────────────────────────
  // "" and null both CLEAR back to not-stated, which an owner needs — they may
  // have answered by mistake, and a field that can only be set is a field that
  // makes the listing lie the first time somebody mis-clicks.
  if (body.smokingPolicy !== undefined) {
    const v = body.smokingPolicy;
    if (v === "" || v === null) out.smokingPolicy = undefined;
    else if (v === "smoking" || v === "non_smoking") out.smokingPolicy = v;
    else return { error: "smokingPolicy must be smoking or non_smoking" };
  }
  if (body.accessible !== undefined) {
    const v = body.accessible;
    if (v === "" || v === null) out.accessible = undefined;
    else if (typeof v === "boolean") out.accessible = v;
    else return { error: "accessible must be true or false" };
  }
  if (body.photos !== undefined) {
    if (!Array.isArray(body.photos)) return { error: "photos must be a list" };
    out.photos = body.photos.map((p) => String(p)).filter(Boolean).slice(0, 20);
  }
  if (body.amenities !== undefined) {
    const v = validateAmenityKeys(venue, body.amenities);
    if (!v.ok) return { error: v.message };
    out.amenities = v.value;
  }
  if (body.isActive !== undefined) out.isActive = Boolean(body.isActive);

  // A ceiling below the base is not a ceiling. Checked against the MERGED
  // values, not the payload, so a patch that moves only one of the two is
  // still judged against what the type will actually hold.
  return { value: out };
}

function checkOccupancyPair(type) {
  const sleeps = Number(type.sleeps) || 0;
  const max = Number(type.maxOccupancy) || 0;
  if (max && max < sleeps) return `maxOccupancy (${max}) cannot be below sleeps (${sleeps}).`;
  return null;
}

/**
 * ── AMENITIES ARE ALWAYS PRESENTED WITH THEIR USAGE ─────────────────────────
 * Only the LIST endpoint attached `usage`; the five write endpoints returned a
 * bare array. The Amenities screen merges whatever a write returns into its
 * state, so the moment an owner added or renamed anything, every row lost its
 * usage and read "Not used yet" — including amenities the Standard type was
 * visibly using two inches away.
 *
 * One presenter, used by every response that carries amenities, so a sixth
 * endpoint cannot forget.
 */
function presentAmenities(venue) {
  const rows = (venue.roomAmenities || []).map((a) => {
    const usage = amenityUsage(venue, a.key);
    return {
      key: a.key,
      label: a.label,
      isActive: a.isActive !== false,
      group: resolveGroup(a),
      usage,
      /**
       * ── FLOAT WHAT THE OWNER HAS ALREADY REACHED FOR ────────────────────
       * An amenity already on some type is one this venue genuinely has, and
       * is far more likely to be wanted on the next type than the twelfth item
       * of a starter list. Surfaced as a FLAG rather than by pre-sorting the
       * array, so a screen can float them WITHIN their group and keep the
       * grouping intact — sorting them all to the top instead would put
       * "Attached bathroom" above the Comfort heading.
       */
      usedBefore: usage.types.length > 0,
    };
  });

  // Stable order: group first (in AMENITY_GROUPS order), used-before next,
  // then the order the owner created them. Nothing is sorted alphabetically —
  // a list an owner has arranged should stay arranged.
  const groupRank = new Map(AMENITY_GROUPS.map((g, i) => [g, i]));
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const ga = groupRank.has(a.r.group) ? groupRank.get(a.r.group) : AMENITY_GROUPS.length;
      const gb = groupRank.has(b.r.group) ? groupRank.get(b.r.group) : AMENITY_GROUPS.length;
      if (ga !== gb) return ga - gb;
      if (a.r.usedBefore !== b.r.usedBefore) return a.r.usedBefore ? -1 : 1;
      return a.i - b.i;
    })
    .map((x) => x.r);
}

/**
 * The payload every write returns, so the client never re-fetches to redraw.
 *
 * Async since ROOMS 7, and decorating through the SAME function venueRooms uses.
 * A type edit returns the whole rooms array, so a rooms array without the delete
 * verdict would silently un-render every Delete button on the screen the moment
 * somebody renamed a type.
 */
async function statePayload(venue, extra = {}) {
  const projection = projectAccommodation(venue);
  return {
    roomTypes: venue.roomTypes || [],
    roomAmenities: presentAmenities(venue),
    rooms: await decorateDeletability(venue._id, resolveRooms(venue)),
    accommodation: venue.accommodation,
    /** Active rooms in no type: real rooms the public listing cannot show. */
    untypedRooms: projection.untyped,
    listingProjected: projection.changed,
    ...extra,
  };
}

// ── GET /venues/:slug/room-types ────────────────────────────────────────────
const listRoomTypes = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    // A read must not persist. statePayload projects onto the in-memory doc to
    // report what the listing WOULD say; nothing is saved here.
    return res.status(200).json(await statePayload(venue));
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// ── POST /venues/:slug/room-types ───────────────────────────────────────────
const addRoomType = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const v = validateTypeInput(venue, req.body || {});
    if (v.error) return res.status(400).json({ message: v.error });
    const clash = (venue.roomTypes || []).find(
      (t) => t.isActive !== false && String(t.name).toLowerCase() === v.value.name.toLowerCase()
    );
    if (clash) return res.status(409).json({ message: `A room type called "${clash.name}" already exists.` });

    venue.roomTypes.push(v.value);
    const created = venue.roomTypes[venue.roomTypes.length - 1];
    const bad = checkOccupancyPair(created);
    if (bad) return res.status(400).json({ message: bad });

    projectAccommodation(venue);
    await venue.save();
    return res.status(201).json(await statePayload(venue, { roomType: created }));
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// ── PATCH /venues/:slug/room-types/:typeId ──────────────────────────────────
// Editing a type cascades to every room of that type EXCEPT overridden fields.
const updateRoomType = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const type = (venue.roomTypes || []).id(req.params.typeId);
    if (!type) return res.status(404).json({ message: "Room type not found" });
    const v = validateTypeInput(venue, req.body || {}, { partial: true });
    if (v.error) return res.status(400).json({ message: v.error });
    if (v.value.name) {
      const clash = (venue.roomTypes || []).find(
        (t) => String(t._id) !== String(type._id) && t.isActive !== false &&
          String(t.name).toLowerCase() === v.value.name.toLowerCase()
      );
      if (clash) return res.status(409).json({ message: `A room type called "${clash.name}" already exists.` });
    }
    Object.assign(type, v.value);
    const bad = checkOccupancyPair(type);
    if (bad) return res.status(400).json({ message: bad });

    const cascaded = applyTypeToRooms(venue, type);
    projectAccommodation(venue);
    await venue.save();
    return res.status(200).json(await statePayload(venue, {
      roomType: type,
      cascadedTo: cascaded,
      inheritableFields: INHERITABLE_FIELDS,
    }));
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// ══ PHOTOS ON A ROOM TYPE ═══════════════════════════════════════════════════
// Ordered, with exactly one cover. Each operation is its own endpoint rather
// than a whole-array PUT, so adding a photo never has to re-send the ones
// already there — the founder's "reordering and removal without re-uploading
// the rest".
//
// THE ONE-COVER INVARIANT IS ENFORCED HERE, not hoped for: setting a cover
// clears every other, and removing the cover promotes the first remaining
// photo. A type with photos and no cover would leave the listing picking one
// arbitrarily, which is the ambiguity an explicit cover exists to remove.

/** Normalise, enforce one cover, and hand back the subdoc array to store. */
function normalisePhotos(rows) {
  const clean = (rows || []).filter((p) => p && p.url);
  if (!clean.length) return [];
  const coverIdx = clean.findIndex((p) => p.isCover);
  return clean.map((p, i) => ({
    url: String(p.url),
    isCover: coverIdx === -1 ? i === 0 : i === coverIdx,
  }));
}

const MAX_PHOTOS_PER_TYPE = 12;

// ── POST /venues/:slug/room-types/:typeId/photos ────────────────────────────
// Body: { urls: [...] } — already uploaded via /file/upload, same as every
// other image path. Appended in the order given.
const addTypePhotos = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const type = (venue.roomTypes || []).id(req.params.typeId);
    if (!type) return res.status(404).json({ message: "Room type not found" });

    const raw = (req.body || {}).urls;
    const urls = (Array.isArray(raw) ? raw : [raw]).map((u) => String(u || "").trim()).filter(Boolean);
    if (!urls.length) return res.status(400).json({ message: "No photos given." });

    const existing = (type.photos || []).map((p) => String(p.url));
    const fresh = urls.filter((u) => !existing.includes(u));
    if (existing.length + fresh.length > MAX_PHOTOS_PER_TYPE) {
      return res.status(400).json({
        message: `A room type can hold ${MAX_PHOTOS_PER_TYPE} photos. This one has ${existing.length}.`,
        code: "photo_limit",
      });
    }

    type.photos = normalisePhotos([...(type.photos || []), ...fresh.map((u) => ({ url: u }))]);
    projectAccommodation(venue);
    await venue.save();
    return res.status(201).json(await statePayload(venue, { roomType: type, added: fresh.length, skipped: urls.length - fresh.length }));
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// ── PUT /venues/:slug/room-types/:typeId/photos/order ───────────────────────
// Body: { urls: [...] } — the full list, in the new order. Must name every
// photo exactly once: a partial list would silently drop whatever it omitted,
// which is the one thing a reorder must never do. Same rule as block ordering.
const reorderTypePhotos = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const type = (venue.roomTypes || []).id(req.params.typeId);
    if (!type) return res.status(404).json({ message: "Room type not found" });

    const want = ((req.body || {}).urls || []).map((u) => String(u));
    const have = (type.photos || []).map((p) => String(p.url));
    if (want.length !== have.length) {
      return res.status(400).json({
        message: `Photos must be listed in full — got ${want.length} of ${have.length}.`,
        code: "reorder_mismatch",
      });
    }
    const seen = new Set();
    for (const u of want) {
      if (!have.includes(u)) return res.status(400).json({ message: "That list contains a photo that is not on this type.", code: "reorder_mismatch" });
      if (seen.has(u)) return res.status(400).json({ message: "That list repeats a photo.", code: "reorder_mismatch" });
      seen.add(u);
    }

    // The COVER FOLLOWS THE PHOTO, not the position — which is the whole point
    // of storing it explicitly. Reordering must not change what a couple sees
    // on the card.
    const coverUrl = (type.photos || []).find((p) => p.isCover);
    const cover = coverUrl ? String(coverUrl.url) : null;
    type.photos = normalisePhotos(want.map((u) => ({ url: u, isCover: u === cover })));
    projectAccommodation(venue);
    await venue.save();
    return res.status(200).json(await statePayload(venue, { roomType: type }));
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// ── PUT /venues/:slug/room-types/:typeId/photos/cover ───────────────────────
const setTypeCover = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const type = (venue.roomTypes || []).id(req.params.typeId);
    if (!type) return res.status(404).json({ message: "Room type not found" });
    const url = String((req.body || {}).url || "").trim();
    if (!(type.photos || []).some((p) => String(p.url) === url)) {
      return res.status(404).json({ message: "That photo is not on this room type." });
    }
    type.photos = normalisePhotos((type.photos || []).map((p) => ({ url: p.url, isCover: String(p.url) === url })));
    projectAccommodation(venue);
    await venue.save();
    return res.status(200).json(await statePayload(venue, { roomType: type }));
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// ── DELETE /venues/:slug/room-types/:typeId/photos ──────────────────────────
// Body/query: { url }. The stored object is deliberately NOT deleted from S3 —
// the same rule every other document path in this repo follows, because a URL
// that stops resolving is worse than an orphan nobody pays for.
const removeTypePhoto = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const type = (venue.roomTypes || []).id(req.params.typeId);
    if (!type) return res.status(404).json({ message: "Room type not found" });
    const url = String((req.body && req.body.url) || req.query.url || "").trim();
    const before = (type.photos || []).length;
    const kept = (type.photos || []).filter((p) => String(p.url) !== url);
    if (kept.length === before) return res.status(404).json({ message: "That photo is not on this room type." });

    // normalisePhotos promotes the first remaining photo when the cover goes,
    // so a type never ends up with photos and no cover.
    type.photos = normalisePhotos(kept.map((p) => ({ url: p.url, isCover: p.isCover })));
    projectAccommodation(venue);
    await venue.save();
    return res.status(200).json(await statePayload(venue, { roomType: type, removed: 1 }));
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// ── DELETE /venues/:slug/room-types/:typeId ─────────────────────────────────
// A type with rooms is never removed silently: the rooms would be orphaned and
// their capacity/rate would freeze at whatever the type last said, with nothing
// on screen explaining why. Refuse and name the count.
const deleteRoomType = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const type = (venue.roomTypes || []).id(req.params.typeId);
    if (!type) return res.status(404).json({ message: "Room type not found" });
    const attached = (venue.rooms || []).filter((r) => String(r.typeRef || "") === String(type._id));
    if (attached.length && String(req.query.force || "") !== "1") {
      return res.status(409).json({
        message: `${attached.length} room${attached.length === 1 ? " is" : "s are"} still this type. Move them to another type first, or deactivate this one.`,
        code: "type_in_use",
        rooms: attached.map((r) => r.name),
      });
    }
    if (attached.length) {
      // Explicit force: keep the rooms, but freeze what they inherited so
      // nothing silently changes value the moment the type disappears.
      for (const room of attached) {
        room.typeRef = null;
        const has = new Set((room.overrides || []).map(String));
        for (const f of INHERITABLE_FIELDS) if (!has.has(f)) room.overrides.push(f);
      }
    }
    type.deleteOne();
    projectAccommodation(venue);
    await venue.save();
    return res.status(200).json(await statePayload(venue, { deleted: true, detached: attached.length }));
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// ══ THE ROOM-AMENITIES LIBRARY ══════════════════════════════════════════════
// Defined once per venue, referenced by types and rooms by KEY. Seeded from a
// starting set rather than fixed as an enum: every venue has something the list
// did not anticipate, and an enum makes that a schema change.
//
// See utils/venueRoomTypes for why this is a new list and not Venue.amenities.

// GET /venues/:slug/room-amenities
const listRoomAmenities = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    return res.status(200).json({
      roomAmenities: presentAmenities(venue),
      suggestions: DEFAULT_ROOM_AMENITIES.filter(
        (d) => !(venue.roomAmenities || []).some((a) => String(a.key) === d.key)
      ),
    });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// POST /venues/:slug/room-amenities
// Body: { label } for one, or { seed: true } to add whatever of the starting
// set is missing. Seeding is additive and idempotent — it never removes or
// relabels an amenity the owner already has.
const addRoomAmenity = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const body = req.body || {};
    const existing = new Set((venue.roomAmenities || []).map((a) => String(a.key)));

    if (body.seed) {
      const added = [];
      for (const d of DEFAULT_ROOM_AMENITIES) {
        if (existing.has(d.key)) continue;
        venue.roomAmenities.push({ key: d.key, label: d.label, group: d.group, isActive: true });
        added.push(d.key);
      }
      await venue.save();
      return res.status(200).json({ seeded: added.length, roomAmenities: presentAmenities(venue) });
    }

    const v = reqStr(body.label, "label", 80);
    if (!v.ok) return res.status(400).json({ message: v.message });
    const key = amenityKeyFor(body.key || v.value);
    if (!key) return res.status(400).json({ message: "That name has no letters or numbers in it." });

    // ── COLLIDE ON THE LABEL TOO, NOT JUST THE KEY ─────────────────────────
    // The key is derived from the label, and the derivation is lossy: "Wi-Fi"
    // becomes `wi_fi`, which does not collide with the seeded `wifi`. Checking
    // only the key would let an owner create a second entry that is
    // indistinguishable from the first on every screen that shows it — the
    // owner sees "Wi-Fi" twice and cannot tell which one their rooms use.
    //
    // Collides against INACTIVE entries too. A key is a reference target: types
    // and rooms still point at retired ones, so reusing a key — or presenting a
    // second entry under a retired one's label — would silently give them a
    // different meaning.
    const wanted = v.value.toLowerCase();
    const clash = (venue.roomAmenities || []).find(
      (a) => String(a.key) === key || String(a.label || "").trim().toLowerCase() === wanted
    );
    if (clash) {
      return res.status(409).json({
        message: clash.isActive === false
          ? `"${clash.label}" is already on the list, switched off. Turn it back on instead.`
          : `"${clash.label}" is already on the list.`,
        code: clash.isActive === false ? "amenity_retired" : "amenity_exists",
        amenity: { key: clash.key, label: clash.label, isActive: clash.isActive !== false },
      });
    }

    // The group the owner picked, or extras. Never guessed from the label —
    // "Jacuzzi" is a bathroom to one venue and an extra to another, and being
    // wrong about it silently is worse than putting it in the obvious bucket.
    const group = AMENITY_GROUPS.includes(String(body.group || "")) ? String(body.group) : "extras";
    venue.roomAmenities.push({ key, label: v.value, group, isActive: true });
    await venue.save();
    return res.status(201).json({
      amenity: venue.roomAmenities[venue.roomAmenities.length - 1],
      roomAmenities: presentAmenities(venue),
    });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// PATCH /venues/:slug/room-amenities/:key — relabel, or switch back on.
// The KEY is immutable: types and rooms reference it. Only the label moves.
const updateRoomAmenity = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const amenity = (venue.roomAmenities || []).find((a) => String(a.key) === String(req.params.key));
    if (!amenity) return res.status(404).json({ message: "Amenity not found" });
    const body = req.body || {};
    if (body.label !== undefined) {
      const v = reqStr(body.label, "label", 80);
      if (!v.ok) return res.status(400).json({ message: v.message });
      amenity.label = v.value;
    }
    if (body.isActive !== undefined) amenity.isActive = Boolean(body.isActive);
    await venue.save();
    return res.status(200).json({ amenity, roomAmenities: presentAmenities(venue) });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// DELETE /venues/:slug/room-amenities/:key
// In use → RETIRED, not removed. Types and rooms hold the key; deleting the
// row would leave those references unresolvable and the amenity would render as
// a raw key, or vanish from a room that genuinely has the thing.
const deleteRoomAmenity = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const idx = (venue.roomAmenities || []).findIndex((a) => String(a.key) === String(req.params.key));
    if (idx === -1) return res.status(404).json({ message: "Amenity not found" });
    const amenity = venue.roomAmenities[idx];
    const usage = amenityUsage(venue, amenity.key);
    const inUse = usage.types.length + usage.rooms.length > 0;

    if (inUse) {
      amenity.isActive = false;
      await venue.save();
      return res.status(200).json({
        retired: true,
        message: `"${amenity.label}" is in use, so it has been switched off rather than deleted. Rooms that have it keep it.`,
        usage,
        roomAmenities: presentAmenities(venue),
      });
    }
    venue.roomAmenities.splice(idx, 1);
    await venue.save();
    return res.status(200).json({ deleted: true, roomAmenities: presentAmenities(venue) });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};


/* ══ HOW THIS VENUE SELLS ITS ROOMS ════════════════════════════════════════ */

/**
 * The policy, always in the resolved shape, alongside the two facts that make
 * it legible: how many rooms the venue actually has, and what one example
 * booking would cost under it.
 *
 * The worked example is not decoration. "8 included, Rs. 4,000 extra" is four
 * numbers an owner has to multiply in their head to know what they just agreed
 * to; showing the arithmetic is how they catch a policy that says something
 * they did not mean before a couple is quoted from it.
 */
async function getRoomsPolicy(req, res) {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const rooms = resolveRooms(venue);
    const totalRooms = rooms.filter((r) => r.isActive !== false).length;
    const policy = resolvePolicy(venue);
    // The type rate the fallback would actually use — reported so the screen
    // can say where a number came from rather than just showing one.
    const rates = (venue.roomTypes || []).map((t) => Number(t.defaultRate) || 0).filter((n) => n > 0);
    const fallbackTypeRate = rates.length ? Math.min(...rates) : 0;
    res.status(200).json({
      policy,
      totalRooms,
      includedUnderPolicy: includedRooms(policy, totalRooms),
      fallbackTypeRate,
      example: quoteRooms({
        policy,
        roomsNeeded: totalRooms,
        nights: 1,
        totalRoomsAtVenue: totalRooms,
        typeRate: fallbackTypeRate,
      }),
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

async function updateRoomsPolicy(req, res) {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const b = req.body || {};

    if (b.includedWithVenue !== undefined && !["all", "none", "count"].includes(b.includedWithVenue)) {
      return res.status(400).json({ message: "includedWithVenue must be all, none or count" });
    }
    const count = optNumber(b.includedCount, "includedCount");
    if (!count.ok) return res.status(400).json({ message: count.message });
    const rate = optNumber(b.extraRoomRate, "extraRoomRate");
    if (!rate.ok) return res.status(400).json({ message: rate.message });
    const bedRate = optNumber(b.extraBedRate, "extraBedRate");
    if (!bedRate.ok) return res.status(400).json({ message: bedRate.message });
    if (bedRate.value !== undefined && bedRate.value < 0) return res.status(400).json({ message: "extraBedRate cannot be negative" });
    if (count.value !== undefined && count.value < 0) return res.status(400).json({ message: "includedCount cannot be negative" });
    if (rate.value !== undefined && rate.value < 0) return res.status(400).json({ message: "extraRoomRate cannot be negative" });

    const current = resolvePolicy(venue);
    const next = {
      // Saving this screen IS the answer — that is what makes the venue
      // configured, and what stops a screen showing a policy nobody wrote.
      configured: true,
      sellsNightly: b.sellsNightly !== undefined ? b.sellsNightly === true : current.sellsNightly,
      includedWithVenue: b.includedWithVenue !== undefined ? b.includedWithVenue : current.includedWithVenue,
      includedCount: count.value !== undefined ? Math.round(count.value) : current.includedCount,
      extraRoomRate: rate.value !== undefined ? Math.round(rate.value) : current.extraRoomRate,
      extraBedRate: bedRate.value !== undefined ? Math.round(bedRate.value) : current.extraBedRate,
    };
    venue.roomsPolicy = next;
    await venue.save();

    // NOTHING re-derives here. Changing the policy changes what the NEXT
    // booking is quoted; it does not touch a booking already confirmed, whose
    // rooms line was written at confirmation and is now that deal's own fact.
    req.params.slug = venue.slug;
    return getRoomsPolicy(req, res);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}


module.exports = {
  getRoomsPolicy,
  updateRoomsPolicy,
  resolveOwnedVenue,
  validateAmenityKeys,
  statePayload,
  listRoomAmenities,
  addRoomAmenity,
  updateRoomAmenity,
  deleteRoomAmenity,
  addTypePhotos,
  reorderTypePhotos,
  setTypeCover,
  removeTypePhoto,
  normalisePhotos,
  listRoomTypes,
  addRoomType,
  updateRoomType,
  deleteRoomType,
  DEFAULT_ROOM_AMENITIES,
};
