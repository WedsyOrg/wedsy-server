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
const VenueRoomAllotment = require("../models/VenueRoomAllotment");
const { reqStr, optStr, optNumber, optCount } = require("../utils/venueInput");
const { expand, planBulk } = require("../utils/venueRoomBulk");
const { validatePlacement } = require("../utils/venueRoomLayout");
const {
  INHERITABLE_FIELDS,
  findType,
  resolveRoom,
  resolveRooms,
  projectAccommodation,
} = require("../utils/venueRoomTypes");

const ROOM_TYPES = ["standard", "deluxe", "suite", "dorm", "other"];
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
    if (!overrides.has("capacity")) room.capacity = Number(type.sleeps) || 2;
    if (!overrides.has("amenities")) room.amenities = (type.amenities || []).map(String);
    if (!overrides.has("rate")) room.rate = Number(type.defaultRate) || 0;
  }
  // With no type there is nothing to inherit FROM, so resolveRoom reads the
  // room's own columns whatever `overrides` says. It is left alone rather than
  // cleared, so the freeze stamp survives an unrelated edit (a rename should
  // not quietly change what a detached room's rate means).
}

function statePayload(venue, extra = {}) {
  const projection = projectAccommodation(venue);
  return {
    rooms: resolveRooms(venue),
    roomTypes: venue.roomTypes || [],
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
    return res.status(200).json(statePayload(venue));
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
    return res.status(201).json(statePayload(venue, {
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
    return res.status(200).json(statePayload(venue, {
      room: resolveRoom(room, findType(venue, room.typeRef)),
    }));
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// DELETE /venues/:slug/rooms/:roomId — listing capability.
// Rooms with allotment history are deactivated (the history must stay
// resolvable); never-used rooms are removed outright.
const deleteRoom = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const room = venue.rooms.id(req.params.roomId);
    if (!room) return res.status(404).json({ message: "Room not found" });
    const used = await VenueRoomAllotment.exists({ venue: venue._id, room: room._id });
    if (used) {
      room.isActive = false;
      projectAccommodation(venue);
      await venue.save();
      return res.status(200).json(statePayload(venue, { deactivated: true }));
    }
    room.deleteOne();
    projectAccommodation(venue);
    await venue.save();
    return res.status(200).json(statePayload(venue, { deleted: true }));
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

    const plan = planBulk(venue, expanded.names);
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

    for (const name of plan.create) {
      venue.rooms.push({ name });
      const room = venue.rooms[venue.rooms.length - 1];
      applyRoomPatch(venue, room, {
        name,
        typeRef: type ? type._id : null,
        isActive: true,
      }, []);
      room.blockRef = place.value.blockRef;
      room.floorRef = place.value.floorRef;
    }
    projectAccommodation(venue);
    await venue.save();

    return res.status(201).json(statePayload(venue, {
      created: plan.create,
      createdCount: plan.create.length,
      skipped: plan.skip,
      ...planBody,
    }));
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

module.exports = { listRooms, addRoom, updateRoom, deleteRoom, bulkCreateRooms, validateRoomInput, applyRoomPatch, statePayload };
