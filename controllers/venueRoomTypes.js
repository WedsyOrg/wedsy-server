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
  applyTypeToRooms,
  projectAccommodation,
  resolveRooms,
} = require("../utils/venueRoomTypes");

const SELECT = "_id slug rooms roomTypes roomAmenities accommodation";

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

/** The payload every write returns, so the client never re-fetches to redraw. */
function statePayload(venue, extra = {}) {
  const projection = projectAccommodation(venue);
  return {
    roomTypes: venue.roomTypes || [],
    roomAmenities: venue.roomAmenities || [],
    rooms: resolveRooms(venue),
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
    return res.status(200).json(statePayload(venue));
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
    return res.status(201).json(statePayload(venue, { roomType: created }));
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
    return res.status(200).json(statePayload(venue, {
      roomType: type,
      cascadedTo: cascaded,
      inheritableFields: INHERITABLE_FIELDS,
    }));
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
    return res.status(200).json(statePayload(venue, { deleted: true, detached: attached.length }));
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

module.exports = {
  resolveOwnedVenue,
  validateAmenityKeys,
  statePayload,
  listRoomTypes,
  addRoomType,
  updateRoomType,
  deleteRoomType,
  DEFAULT_ROOM_AMENITIES,
};
