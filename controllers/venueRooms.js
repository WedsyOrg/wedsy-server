/**
 * controllers/venueRooms.js — Phase 5 (PMS) rooms inventory CRUD.
 * Lives on Venue.rooms[] (venue-owned subdocs). Writes are listing-gated at
 * the route; reads are open to any authenticated venue identity.
 *
 * ── ROOMS 2 ─────────────────────────────────────────────────────────────────
 * A room now belongs to a TYPE and inherits capacity, amenities and rate from
 * it. Two consequences run through every handler here:
 *
 *  1. SETTING AN INHERITED FIELD IS AN OVERRIDE, AND IT IS RECORDED BY NAME.
 *     `room.overrides` is a list of field names, not a guess. Inference from
 *     "does this room's value differ from its type's" cannot tell a deliberate
 *     3 from a 3 that was inherited before the type changed — so the first type
 *     edit after such a guess either clobbers real intent or freezes rooms that
 *     never diverged.
 *
 *  2. ANYTHING THAT CHANGES THE ROOM POPULATION RE-DERIVES THE LISTING.
 *     accommodation.roomTypes[].count is now the number of ACTIVE rooms of a
 *     type. Adding, deactivating or deleting a room moves it.
 *
 * Reads return RESOLVED rooms (post-inheritance) plus what each has overridden,
 * so no caller has to reimplement the rule. Allotment and check-in read
 * `capacity` off the stored subdoc, which inheritance keeps in step — see
 * utils/venueRoomTypes.applyTypeToRooms.
 */
const Venue = require("../models/Venue");
const { heldNightsForRoom, releaseHeldNightsForRoom } = require("../utils/venueRoomNights");
const {
  roomsWithHistory,
  deletabilityFor,
  decorateDeletability,
  sweepRoomNights,
} = require("../utils/venueRoomDeletion");
const { reqStr, optStr, optNumber, optCount } = require("../utils/venueInput");
const { expand, planBulk } = require("../utils/venueRoomBulk");
const { validatePlacement } = require("../utils/venueRoomLayout");
const {
  INHERITABLE_FIELDS,
  findType,
  occupancyOf,
  resolveRoom,
  resolveRooms,
  projectAccommodation,
  presentTypes,
} = require("../utils/venueRoomTypes");

const ROOM_TYPES = ["standard", "deluxe", "suite", "dorm", "other"];

/**
 * ── TAKING A ROOM OUT OF SERVICE IS A PROMISE THE VENUE HAS ALREADY MADE ────
 * One refusal, used by every path that can remove a room from availability, so
 * a delete cannot warn about less than a deactivation does.
 *
 * The guards here USED to read VenueRoomAllotment — a guest assigned. A booking
 * that reserved a COUNT of rooms at confirmation has no allotment yet, which is
 * the whole design of ROOMS 1, so those guards saw an unused room and removed
 * it. The room-nights stayed, pointing at nothing: the booking still counted 20
 * rooms and the property could supply 19.
 *
 * Refuse first, allow on purpose — the same shape as rooms_short at
 * confirmation and stale holds on a window change. The venue is never blocked
 * from managing its property, only from doing it by accident.
 *
 * @returns the 409 payload, or null when there is nothing to warn about.
 */
async function heldNightsRefusal(venue, room, req, { verb }) {
  // Both spellings accepted: `?force=1` is what deleteBlock and deleteRoomType
  // already use, and the body flag is what the confirm-booking acknowledgements
  // use. One mechanism per codebase would be nicer than two, but a caller
  // guessing wrong and having its warning silently ignored would be worse.
  const forced =
    String((req.query && req.query.force) || "") === "1" ||
    (req.body && req.body.acknowledgeHeldNights === true);
  if (forced) return null;

  const held = await heldNightsForRoom(venue._id, room._id);
  if (held.upcoming === 0) return null;

  const who = held.bookings
    .map((b) => `${b.coupleName || "a booking"} (${b.nights} night${b.nights === 1 ? "" : "s"} from ${venueDateKey(b.firstNight)})`)
    .join(", ");
  return {
    code: "room_has_held_nights",
    message:
      `"${room.name}" is promised to ${held.bookings.length} booking${held.bookings.length === 1 ? "" : "s"} — ${who}. ` +
      `${verb} it anyway and ${held.upcoming === 1 ? "that night" : "those nights"} will no longer have a room behind ${held.upcoming === 1 ? "it" : "them"}.`,
    upcoming: held.upcoming,
    past: held.past,
    bookings: held.bookings.map((b) => ({
      bookingId: b.bookingId,
      coupleName: b.coupleName,
      nights: b.nights,
      firstNight: b.firstNight,
      lastNight: b.lastNight,
    })),
    acknowledgeWith: "acknowledgeHeldNights",
  };
}

/** "30 Sep 2036" — the venue's own day key, not an ISO timestamp. */
const venueDateKey = (d) =>
  new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
// `blocks` is in here because validatePlacement and resolveLayout read it, and
// a select that omits it does not fail loudly — it makes every block look
// absent, so a correct guard refuses a placement that was perfectly valid. That
// is the shape of bug this repo has been bitten by before: the guard is right,
// the arguments it was given are not.
const SELECT = "_id slug rooms roomTypes roomAmenities accommodation blocks";

async function resolveOwnedVenue(req, res, select = SELECT) {
  const venue = await Venue.findOne({ slug: req.params.slug }).select(select);
  if (!venue) { res.status(404).json({ message: "Venue not found" }); return null; }
  if (String(venue._id) !== String(req.venueOwner.venueId)) { res.status(403).json({ message: "Forbidden" }); return null; }
  return venue;
}

/** Amenity keys must resolve against this venue's library — no free text. */
function validateAmenityKeys(venue, raw) {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(raw)) return { ok: false, message: "amenities must be a list" };
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

function validateRoomInput(venue, body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.name !== undefined) {
    const v = reqStr(body.name, "name", 200);
    if (!v.ok) return { error: v.message };
    out.name = v.value;
  }
  if (body.typeRef !== undefined) {
    if (body.typeRef === null || body.typeRef === "") {
      out.typeRef = null;
    } else {
      const type = findType(venue, body.typeRef);
      if (!type) return { error: "That room type does not exist at this venue." };
      if (type.isActive === false) return { error: `"${type.name}" is no longer an active room type.` };
      out.typeRef = type._id;
    }
  }
  if (body.type !== undefined) {
    if (!ROOM_TYPES.includes(body.type)) return { error: `type must be one of: ${ROOM_TYPES.join(", ")}` };
    out.type = body.type;
  }
  if (body.capacity !== undefined) {
    const v = optCount(body.capacity, "capacity", { max: 1000 });
    if (!v.ok) return { error: v.message };
    if (v.value !== undefined) out.capacity = v.value;
  }
  if (body.rate !== undefined) {
    const v = optNumber(body.rate, "rate", { max: 1e9 });
    if (!v.ok) return { error: v.message };
    if (v.value !== undefined) out.rate = v.value;
  }
  if (body.amenities !== undefined) {
    const v = validateAmenityKeys(venue, body.amenities);
    if (!v.ok) return { error: v.message };
    out.amenities = v.value;
  }
  if (body.notes !== undefined) {
    const v = optStr(body.notes, "notes", 2000);
    if (!v.ok) return { error: v.message };
    out.notes = v.value;
  }
  if (body.isActive !== undefined) out.isActive = Boolean(body.isActive);
  return { value: out };
}

/**
 * Apply a validated patch, keeping `overrides` honest.
 *
 * An inherited field named in the payload becomes this room's own. A field
 * named in `clearOverrides` goes back to the type and re-reads its value now —
 * not the value it had when it diverged, which would leave the room stale the
 * moment it stopped claiming to be different.
 */
function applyRoomPatch(venue, room, patch, clearList) {
  const hadNoType = !room.typeRef;
  Object.assign(room, patch);
  const overrides = new Set((room.overrides || []).map(String));

  // ── JOINING A TYPE FROM NOWHERE MEANS ADOPTING IT ────────────────────────
  // A room with no type carries an override stamp it never chose: detaching
  // one (venueRoomTypes.deleteRoomType --force) marks every field as its own so
  // its values freeze rather than silently reverting. That stamp is a freeze,
  // not an owner's decision, so it must not outlive the room being given a
  // type — otherwise the room joins Deluxe and inherits nothing from it.
  //
  // A room moving BETWEEN types keeps its overrides: those were chosen.
  if (hadNoType && patch.typeRef) overrides.clear();

  for (const f of INHERITABLE_FIELDS) {
    if (patch[f] !== undefined) overrides.add(f);
  }
  for (const f of clearList || []) {
    if (INHERITABLE_FIELDS.includes(f)) overrides.delete(f);
  }
  room.overrides = Array.from(overrides);

  // Re-read every non-overridden field from the (possibly new) type, so a room
  // that changes type, or drops an override, is correct immediately rather than
  // at the next type edit.
  const type = findType(venue, room.typeRef);
  if (type) {
    // Through occupancyOf, NOT `type.sleeps` directly. This read `.sleeps` and
    // silently produced 2 for every room the moment the field it reads stopped
    // being the field the type writes — a resolver swapped underneath a caller
    // whose default arguments nobody diffed. Caught by a fixture asserting a
    // literal 4.
    if (!overrides.has("capacity")) room.capacity = occupancyOf(type).base;
    if (!overrides.has("amenities")) room.amenities = (type.amenities || []).map(String);
    if (!overrides.has("rate")) room.rate = Number(type.defaultRate) || 0;
  }
  // With no type there is nothing to inherit FROM, so resolveRoom reads the
  // room's own columns whatever `overrides` says. It is left alone rather than
  // cleared, so the freeze stamp survives an unrelated edit (a rename should
  // not quietly change what a detached room's rate means).
}

// Async since ROOMS 7: every room carries whether it can be deleted and, when
// it cannot, why — see utils/venueRoomDeletion. That answer needs the venue's
// allotment history, which is one query for the whole list rather than one per
// room.
async function statePayload(venue, extra = {}) {
  const projection = projectAccommodation(venue);
  return {
    rooms: await decorateDeletability(venue._id, resolveRooms(venue)),
    // Presented, not raw — the fourth endpoint to carry types, and the shape has
    // to be the one the other three return. See utils/venueRoomTypes.
    roomTypes: presentTypes(venue),
    accommodation: venue.accommodation,
    untypedRooms: projection.untyped,
    ...extra,
  };
}

// GET /venues/:slug/rooms — open read (all roles).
const listRooms = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    return res.status(200).json(await statePayload(venue));
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// POST /venues/:slug/rooms — listing capability.
const addRoom = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const body = req.body || {};
    const v = validateRoomInput(venue, body);
    if (v.error) return res.status(400).json({ message: v.error });

    const clash = (venue.rooms || []).find(
      (r) => String(r.name).trim().toLowerCase() === v.value.name.toLowerCase()
    );
    if (clash) {
      return res.status(409).json({
        message: `A room called "${clash.name}" already exists.`,
        code: "room_name_taken",
      });
    }

    // A single room can be placed at creation too — the same pair, validated
    // together, so the one-at-a-time path is not worse than the bulk one.
    const place = validatePlacement(venue, body.blockRef || null, body.floorRef || null);
    if (!place.ok) return res.status(400).json({ message: place.message });

    venue.rooms.push({ name: v.value.name });
    const room = venue.rooms[venue.rooms.length - 1];
    applyRoomPatch(venue, room, v.value, []);
    room.blockRef = place.value.blockRef;
    room.floorRef = place.value.floorRef;
    projectAccommodation(venue);
    await venue.save();
    return res.status(201).json(await statePayload(venue, {
      room: resolveRoom(room, findType(venue, room.typeRef)),
    }));
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// PATCH /venues/:slug/rooms/:roomId — listing capability.
const updateRoom = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const room = venue.rooms.id(req.params.roomId);
    if (!room) return res.status(404).json({ message: "Room not found" });
    const body = req.body || {};
    const v = validateRoomInput(venue, body, { partial: true });
    if (v.error) return res.status(400).json({ message: v.error });

    // Only when this patch is actually taking the room OUT of service.
    // Re-activating, renaming or re-typing a room changes no promise, and
    // warning about those would train an owner to force past the warning that
    // matters. Checked against the room's CURRENT state so re-saving an
    // already-inactive room does not warn again.
    let freed = null;
    if (v.value.isActive === false && room.isActive !== false) {
      const refusal = await heldNightsRefusal(venue, room, req, { verb: "Take" });
      if (refusal) return res.status(409).json(refusal);
      freed = await releaseHeldNightsForRoom(venue._id, room._id);
    }

    if (v.value.name) {
      const clash = (venue.rooms || []).find(
        (r) => String(r._id) !== String(room._id) &&
          String(r.name).trim().toLowerCase() === v.value.name.toLowerCase()
      );
      if (clash) return res.status(409).json({ message: `A room called "${clash.name}" already exists.`, code: "room_name_taken" });
    }

    const clearList = Array.isArray(body.clearOverrides) ? body.clearOverrides.map(String) : [];
    applyRoomPatch(venue, room, v.value, clearList);
    projectAccommodation(venue);
    await venue.save();
    return res.status(200).json(await statePayload(venue, {
      room: resolveRoom(room, findType(venue, room.typeRef)),
      // Reported so "12 nights were released" is something the owner READS,
      // not something they discover later on the booking.
      ...(freed ? { releasedNights: freed } : {}),
    }));
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// DELETE /venues/:slug/rooms/:roomId — listing capability.
//
// ── DELETING IS NOW A SECOND STEP, AND A REFUSAL IS NOW A REFUSAL ───────────
// Two things changed here, and they are really one change: this route used to
// answer a request it had not been given.
//
//   · A room with allotment history was DEACTIVATED and returned 200. The
//     caller asked to delete, was told it worked, and the room was still on the
//     property. The deactivation was right — a stay refers to that room id and
//     always will. Doing it under the name "delete" was not. It now refuses and
//     says so, permanently.
//
//   · A room in service deleted outright. Deletion cannot be undone, so it is
//     no longer one click away from a live room: deactivate first, then delete.
//     That also puts the held-nights question — which already lives on
//     deactivation — before the owner while the action is still reversible.
//
// The held-nights guard (ROOMS 6 slice 0) is unchanged and still runs here: a
// room deactivated before that guard existed can still be holding nights, and
// this is the last moment anyone can be told.
const deleteRoom = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const room = venue.rooms.id(req.params.roomId);
    if (!room) return res.status(404).json({ message: "Room not found" });

    // The same verdict the room carries on every read, from the same function,
    // so the screen and the write cannot disagree about what is on offer.
    const withHistory = await roomsWithHistory(venue._id, [room]);
    const verdict = deletabilityFor(room, withHistory);
    if (!verdict.deletable) {
      return res.status(409).json({
        code: verdict.undeletable.code,
        message: `"${room.name}" cannot be deleted. ${verdict.undeletable.reason}`,
        // Named, so a caller can offer the action that IS available without
        // parsing the sentence to work out which case it is in.
        canDeactivate: verdict.undeletable.code === "room_active",
      });
    }

    // ROOMS 6, unchanged. A deactivated room can still be holding nights, and
    // the booking holding them is named before they go.
    const refusal = await heldNightsRefusal(venue, room, req, { verb: "Delete" });
    if (refusal) return res.status(409).json(refusal);
    // Forced past the warning: the holds go, so the booking stops believing it
    // has a room it does not. Reported, never silent.
    const freedOnDelete = await releaseHeldNightsForRoom(venue._id, room._id);

    // ── AND THE ROWS THE RELEASE DOES NOT COVER ─────────────────────────────
    // Past nights never block a delete — correctly, they are already consumed —
    // and they were never cleaned up either. Without this the room goes and its
    // rows stay, pointing at an id that no longer resolves. Measured: 2 rows
    // left behind. See utils/venueRoomDeletion.sweepRoomNights.
    const sweptNights = await sweepRoomNights(venue._id, room._id);

    const name = room.name;
    room.deleteOne();
    projectAccommodation(venue);
    await venue.save();
    return res.status(200).json(await statePayload(venue, {
      deleted: true,
      deletedName: name,
      releasedNights: freedOnDelete,
      /** Rows removed with the room, so nothing is swept in silence. */
      sweptNights,
    }));
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// ── POST /venues/:slug/rooms/bulk — listing capability ──────────────────────
// Create a floor at a time: a range (101→110) or an explicit list.
//
// ── COLLISIONS NEVER SILENTLY OVERWRITE, AND NEVER FAIL THE WHOLE BATCH ─────
// Creating 101–110 when 105 exists is the normal case, not an error: an owner
// adding a floor does not remember every room already on it. So the default is
// to REFUSE ONCE and say exactly what clashes — the owner then re-sends with
// onCollision: "skip" and gets the other nine.
//
// Three behaviours were deliberately not chosen:
//   · overwrite  — 105 is a real room with allotment history behind it
//   · fail all   — nine good rooms lost to one clash the owner did not know of
//   · skip quietly — the owner believes they created ten and has nine
//
// `preview: true` runs the identical plan and writes nothing, so the screen can
// show the outcome before the owner commits to it.
const bulkCreateRooms = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const body = req.body || {};

    // ── WHERE THEY GO, VALIDATED BEFORE ANYTHING IS EXPANDED ──────────────
    // Block, floor, type and range in ONE action: the wizard's third step is
    // "add the rooms", and making an owner create a floor's worth of rooms and
    // then place them one at a time is the same round trip this build removes
    // everywhere else.
    //
    // Validated FIRST, with the type, so a bad placement fails on nothing
    // rather than on half a floor — the same reason the type is resolved early.
    const place = validatePlacement(venue, body.blockRef || null, body.floorRef || null);
    if (!place.ok) return res.status(400).json({ message: place.message });

    // The type is resolved BEFORE expanding, so a bad type fails on nothing
    // rather than half a floor.
    let type = null;
    if (body.typeRef) {
      type = findType(venue, body.typeRef);
      if (!type) return res.status(400).json({ message: "That room type does not exist at this venue." });
      if (type.isActive === false) return res.status(400).json({ message: `"${type.name}" is no longer an active room type.` });
    }

    const expanded = expand(body);
    if (expanded.error) return res.status(400).json({ message: expanded.error });

    // The target travels in so each clash can say whether it is ALREADY here.
    const plan = planBulk(venue, expanded.names, place.value);
    const onCollision = String(body.onCollision || "");
    const preview = body.preview === true;

    const planBody = {
      requested: expanded.names.length,
      willCreate: plan.create,
      willSkip: plan.skip,
      type: type ? { _id: type._id, name: type.name } : null,
      // Reported so the preview states WHERE as well as what — preview and
      // apply are one computation, and a preview silent about placement would
      // be promising less than the apply does.
      placement: place.value,
    };

    if (preview) {
      return res.status(200).json({ preview: true, ...planBody });
    }

    if (plan.skip.length && onCollision !== "skip") {
      return res.status(409).json({
        message: plan.skip.length === 1
          ? `${plan.skip[0].message} The other ${plan.create.length} can still be created.`
          : `${plan.skip.length} of these already exist. The other ${plan.create.length} can still be created.`,
        code: "bulk_collision",
        hint: 'Send the same request again with onCollision: "skip" to create the rest.',
        ...planBody,
      });
    }

    if (!plan.create.length) {
      return res.status(409).json({
        message: "Every room in that batch already exists. Nothing to create.",
        code: "bulk_all_exist",
        ...planBody,
      });
    }

    // ── ONE WRITER WINS, ATOMICALLY ────────────────────────────────────────
    // `plan` was computed on a stale read. Two concurrent creates of 301–303
    // both planned the same three, both pushed, and six rooms landed — the
    // double-click on "Create" that the block/floor/type creates were already
    // guarded against. Same guard: a single updateOne whose FILTER asserts
    // none of the planned names exist, so of two writers exactly one matches.
    // The loser re-plans on a fresh read and reports its names as clashes,
    // which is the truth by the time it looks.
    const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const docs = plan.create.map((name) => {
      const draft = { name, typeRef: type ? type._id : null, isActive: true, blockRef: place.value.blockRef, floorRef: place.value.floorRef };
      // Inheritance snapshot, exactly as applyRoomPatch would have written it.
      if (type) {
        draft.capacity = occupancyOf(type).base;
        draft.amenities = (type.amenities || []).map(String);
        draft.rate = Number(type.defaultRate) || 0;
      }
      return draft;
    });
    const filter = {
      _id: venue._id,
      rooms: { $not: { $elemMatch: { name: { $in: plan.create.map((n) => new RegExp(`^\\s*${esc(n)}\\s*$`, "i")) } } } },
    };
    const wrote = await Venue.updateOne(filter, { $push: { rooms: { $each: docs } } });
    if (wrote.matchedCount === 0) {
      // Somebody else created at least one of these between our plan and our
      // write. Re-plan on the truth and answer as a collision, never a dupe.
      const fresh = await resolveOwnedVenue(req, res);
      if (!fresh) return;
      const replan = planBulk(fresh, expanded.names, place.value);
      return res.status(409).json({
        message: replan.skip.length === 1
          ? `${replan.skip[0].message} The other ${replan.create.length} can still be created.`
          : `${replan.skip.length} of these already exist. The other ${replan.create.length} can still be created.`,
        code: "bulk_collision",
        hint: 'Send the same request again with onCollision: "skip" to create the rest.',
        requested: expanded.names.length, willCreate: replan.create, willSkip: replan.skip,
        type: type ? { _id: type._id, name: type.name } : null, placement: place.value,
      });
    }
    // Re-read so the projection and the response see what actually landed.
    const venueAfter = await resolveOwnedVenue(req, res);
    if (!venueAfter) return;
    projectAccommodation(venueAfter);
    await venueAfter.save();
    const venueOut = venueAfter;

    return res.status(201).json(await statePayload(venueOut, {
      created: plan.create,
      createdCount: plan.create.length,
      skipped: plan.skip,
      ...planBody,
    }));
  } catch (err) { return res.status(500).json({ message: err.message }); }
};


module.exports = { listRooms, addRoom, updateRoom, deleteRoom, bulkCreateRooms, validateRoomInput, applyRoomPatch, statePayload };
