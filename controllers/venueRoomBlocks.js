/**
 * controllers/venueRoomBlocks.js — the property's shape: blocks and their floors.
 *
 * Both levels are OPTIONAL, and this controller never creates either on the
 * owner's behalf. A venue with no blocks is a valid, complete venue —
 * utils/venueRoomLayout.resolveLayout gives it a uniform shape to render, so
 * there is nothing to fix up here.
 *
 * ── NAMES ARE STORED EXACTLY AS TYPED ───────────────────────────────────────
 * "Ground", "G", "0", "Garden Block", "Cottages". Not title-cased, not
 * expanded, not renumbered. The only thing done to a name is trimming the
 * whitespace around it, because leading spaces are a slip and never a choice.
 *
 * ── ORDER IS THE ARRAY ──────────────────────────────────────────────────────
 * Position is the owner's order and reordering rewrites the array. There is no
 * `order` integer to fall out of step with it, and nothing sorts by name — see
 * the resolver for why every sorting rule fails on real floor names.
 */
const Venue = require("../models/Venue");
const { reqStr } = require("../utils/venueInput");
const { resolveLayout, validatePlacement } = require("../utils/venueRoomLayout");
const { isValidStatus, HOUSEKEEPING_STATUSES } = require("../utils/venueHousekeeping");
const { dayStart: ooDayStart } = require("../utils/venueOutOfOrder");
const { heldNightsForRoom, releaseHeldNightsForRoom } = require("../utils/venueRoomNights");
const VenueTeamMember = require("../models/VenueTeamMember");
const { isOwnerActor } = require("../utils/venueRbac");

/** Who set this status. "Cleared by Meena" is the whole value of the field. */
async function housekeepingActorName(req) {
  if (await isOwnerActor(req.venueOwner, req.venueMember)) return "Owner";
  const m = await VenueTeamMember.findById(req.venueOwner && req.venueOwner.memberId).select("name").lean();
  return (m && m.name) || "team member";
}
const { resolveRooms } = require("../utils/venueRoomTypes");
const { decorateDeletability } = require("../utils/venueRoomDeletion");
const { roomStatusOn, statusTotals } = require("../utils/venueRoomStatus");
const { setupState } = require("../utils/venueRoomSetup");

// `blocks` AND `roomSetup` are both here for the same reason: mongoose does not
// complain when you set a field that was not selected — it simply does not
// persist it. Omitting `blocks` made every placement look invalid; omitting
// `roomSetup` made "one building, one floor" appear to work and then send the
// owner back to step one on the next read. Neither failed loudly.
const SELECT = "_id slug rooms roomTypes roomAmenities accommodation blocks roomSetup";

async function resolveOwnedVenue(req, res, select = SELECT) {
  const venue = await Venue.findOne({ slug: req.params.slug }).select(select);
  if (!venue) { res.status(404).json({ message: "Venue not found" }); return null; }
  if (String(venue._id) !== String(req.venueOwner.venueId)) { res.status(403).json({ message: "Forbidden" }); return null; }
  return venue;
}

const idOf = (v) => (v === null || v === undefined ? "" : String(v._id || v));

/**
 * The whole shape, resolved: structure, rooms (inheritance already applied),
 * and — when asked — what each room IS today.
 *
 * ── ONE SOURCE FOR EVERY COUNT ON THE SCREEN ────────────────────────────────
 * The old page showed "20 active rooms", "Rooms · 21" and "20 rooms" at once,
 * because three components each counted for themselves off differently-filtered
 * arrays. `counts` is computed once in resolveLayout and is the only thing any
 * screen is given, so the three cannot disagree again.
 */
async function layoutPayload(venue, extra = {}, { withStatus = true, on } = {}) {
  // ── DECORATED, BECAUSE THE LAYOUT IS NOW WHERE A ROOM IS EDITED ───────────
  // ROOMS 8 moved deactivate and delete out of the flat room list and onto the
  // room's chip on the layout, so this payload is what the drawer's Delete
  // button reads. It used to call resolveRooms directly, which resolves
  // inheritance but knows nothing about deletability — so `deletable` arrived
  // undefined and the drawer would have offered Delete on nothing, ever.
  //
  // Measured before this line changed:
  //   GET /room-blocks → first room → deletable: undefined
  //
  // A correct guard reading a field the projection dropped: the button is right,
  // its argument is not. Same function the rooms-state payload and the DELETE
  // route use, so all three agree about what may be deleted.
  const byId = new Map(
    (await decorateDeletability(venue._id, resolveRooms(venue))).map((r) => [String(r._id), r]),
  );
  const status = withStatus ? await roomStatusOn(venue, on || new Date()) : null;
  const layout = resolveLayout(venue, {
    presentRoom: (r) => {
      const resolved = byId.get(String(r._id)) || r;
      if (!status) return resolved;
      return { ...resolved, ...(status.get(String(r._id)) || { status: "free" }) };
    },
  });
  return {
    blocks: venue.blocks || [],
    layout: layout.blocks,
    counts: { ...layout.counts, ...(status ? { status: statusTotals(status) } : {}) },
    roomTypes: venue.roomTypes || [],
    ...extra,
  };
}

// ── GET /venues/:slug/room-setup ────────────────────────────────────────────
// Which step, and why. The step is DERIVED from what exists, so this is
// resumable by construction — see utils/venueRoomSetup.
const getSetup = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    return res.status(200).json({
      setup: setupState(venue),
      blocks: venue.blocks || [],
      roomTypes: venue.roomTypes || [],
      roomAmenities: venue.roomAmenities || [],
    });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// ── POST /venues/:slug/room-setup/skip-shape ────────────────────────────────
// "One building, one floor." The ONE thing about the shape step that cannot be
// derived: skipping leaves no blocks, which is byte-identical to never having
// done it, and without recording it the wizard sends the owner back forever.
const skipShape = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    if ((venue.blocks || []).length > 0) {
      // Not an error — just already answered, and saying so beats silently
      // setting a flag that now contradicts what is on screen.
      return res.status(409).json({
        message: "This property already has blocks, so there is nothing to skip.",
        code: "shape_exists",
        setup: setupState(venue),
      });
    }
    venue.roomSetup = { ...(venue.roomSetup || {}), shapeSkipped: true };
    await venue.save();
    return res.status(200).json({ setup: setupState(venue) });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// ── POST /venues/:slug/room-setup/complete ──────────────────────────────────
// Rooms existing already hides the wizard; this is what stops it RETURNING if
// an owner later removes every room.
const completeSetup = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    if (!venue.roomSetup || !venue.roomSetup.completedAt) {
      venue.roomSetup = { ...(venue.roomSetup || {}), completedAt: new Date() };
      await venue.save();
    }
    return res.status(200).json({ setup: setupState(venue) });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// ── POST /venues/:slug/room-setup/dismiss ───────────────────────────────────
// "Not now." Stops it interrupting; the empty Rooms page still offers it, so
// nothing becomes unreachable.
const dismissSetup = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    venue.roomSetup = { ...(venue.roomSetup || {}), dismissedAt: new Date() };
    await venue.save();
    return res.status(200).json({ setup: setupState(venue) });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// ── GET /venues/:slug/room-blocks ───────────────────────────────────────────
const getLayout = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    return res.status(200).json(await layoutPayload(venue));
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// ── POST /venues/:slug/room-blocks ──────────────────────────────────────────
// Body: { name, floors?: string[] } — floors optional, created in the order given.
const addBlock = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const body = req.body || {};
    const v = reqStr(body.name, "name", 120);
    if (!v.ok) return res.status(400).json({ message: v.message });

    const clash = (venue.blocks || []).find(
      (b) => String(b.name).trim().toLowerCase() === v.value.toLowerCase()
    );
    if (clash) {
      return res.status(409).json({ message: `There is already a block called "${clash.name}".`, code: "block_exists" });
    }

    let floors = [];
    if (body.floors !== undefined) {
      if (!Array.isArray(body.floors)) return res.status(400).json({ message: "floors must be a list" });
      const seen = new Set();
      for (const raw of body.floors) {
        const f = reqStr(raw, "floor name", 120);
        if (!f.ok) return res.status(400).json({ message: f.message });
        const key = f.value.toLowerCase();
        if (seen.has(key)) {
          return res.status(409).json({ message: `"${f.value}" is listed twice.`, code: "floor_duplicate" });
        }
        seen.add(key);
        floors.push({ name: f.value });
      }
    }

    venue.blocks.push({ name: v.value, floors });
    await venue.save();
    const created = venue.blocks[venue.blocks.length - 1];
    return res.status(201).json(await layoutPayload(venue, { block: created }));
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// ── PATCH /venues/:slug/room-blocks/:blockId ────────────────────────────────
// Rename, and take out of use / put back. Floors are their own endpoints; order
// is its own endpoint.
//
// `isActive` is what makes deletion a second step (see deleteBlock). It is
// ORGANISATIONAL ONLY — the rooms inside stay exactly as sellable as they were,
// because a block is where a room is, not whether it can be sold.
const updateBlock = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const block = (venue.blocks || []).id(req.params.blockId);
    if (!block) return res.status(404).json({ message: "Block not found" });
    const body = req.body || {};

    // A rename and a retire are separate acts and arrive separately, so a
    // payload carrying only isActive must not be failed for having no name.
    if (body.name !== undefined) {
      const v = reqStr(body.name, "name", 120);
      if (!v.ok) return res.status(400).json({ message: v.message });
      const clash = (venue.blocks || []).find(
        (b) => idOf(b._id) !== idOf(block._id) && String(b.name).trim().toLowerCase() === v.value.toLowerCase()
      );
      if (clash) return res.status(409).json({ message: `There is already a block called "${clash.name}".`, code: "block_exists" });
      block.name = v.value;
    } else if (body.isActive === undefined) {
      // Neither field: the old contract required a name, and silently
      // succeeding on an empty patch would be a worse answer than saying so.
      const v = reqStr(body.name, "name", 120);
      return res.status(400).json({ message: v.message });
    }

    if (body.isActive !== undefined) block.isActive = Boolean(body.isActive);

    await venue.save();
    return res.status(200).json(await layoutPayload(venue, { block }));
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// ── DELETE /venues/:slug/room-blocks/:blockId ───────────────────────────────
//
// Two refusals, and they answer different questions.
//
//  1. IS THIS A DELIBERATE, SECOND ACT? Deleting cannot be undone, so a block
//     in use is not deletable in one click — it is taken out of use first and
//     deleted from there. Same shape as a room.
//
//  2. WHAT BECOMES OF THE ROOMS INSIDE? They are NOT cascaded — a room is real
//     inventory and its block is only a label for where it sits — so they are
//     unplaced instead. That is the right behaviour and it is the one an owner
//     would never guess, which is why it is stated, with the count and the
//     names, BEFORE it happens rather than discovered afterwards.
const deleteBlock = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const block = (venue.blocks || []).id(req.params.blockId);
    if (!block) return res.status(404).json({ message: "Block not found" });

    if (block.isActive !== false) {
      return res.status(409).json({
        code: "block_active",
        message: `"${block.name}" is still in use. Take it out of use first — deleting a block cannot be undone.`,
        canDeactivate: true,
      });
    }

    const inside = (venue.rooms || []).filter((r) => idOf(r.blockRef) === idOf(block._id));
    if (inside.length && String(req.query.force || "") !== "1") {
      return res.status(409).json({
        message: `${inside.length} room${inside.length === 1 ? " is" : "s are"} in ${block.name}. Removing it leaves ${inside.length === 1 ? "it" : "them"} unplaced.`,
        code: "block_in_use",
        rooms: inside.map((r) => r.name),
        /** The count on its own field, so a screen need not parse the sentence. */
        roomCount: inside.length,
      });
    }
    for (const r of inside) { r.blockRef = null; r.floorRef = null; }
    const name = block.name;
    block.deleteOne();
    await venue.save();
    return res.status(200).json(await layoutPayload(venue, {
      deleted: true, deletedName: name, unplaced: inside.length,
    }));
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// ── POST /venues/:slug/room-blocks/:blockId/floors ──────────────────────────
const addFloor = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const block = (venue.blocks || []).id(req.params.blockId);
    if (!block) return res.status(404).json({ message: "Block not found" });
    const v = reqStr((req.body || {}).name, "name", 120);
    if (!v.ok) return res.status(400).json({ message: v.message });
    const clash = (block.floors || []).find((f) => String(f.name).trim().toLowerCase() === v.value.toLowerCase());
    if (clash) {
      return res.status(409).json({ message: `${block.name} already has a floor called "${clash.name}".`, code: "floor_exists" });
    }
    block.floors.push({ name: v.value });
    await venue.save();
    return res.status(201).json(await layoutPayload(venue, { floor: block.floors[block.floors.length - 1] }));
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// ── PATCH /venues/:slug/room-blocks/:blockId/floors/:floorId ────────────────
// Rename, and take out of use / put back — the same two fields, the same
// organisational-only meaning, as a block.
const updateFloor = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const block = (venue.blocks || []).id(req.params.blockId);
    if (!block) return res.status(404).json({ message: "Block not found" });
    const floor = (block.floors || []).id(req.params.floorId);
    if (!floor) return res.status(404).json({ message: "Floor not found" });
    const body = req.body || {};

    if (body.name !== undefined) {
      const v = reqStr(body.name, "name", 120);
      if (!v.ok) return res.status(400).json({ message: v.message });
      const clash = (block.floors || []).find(
        (f) => idOf(f._id) !== idOf(floor._id) && String(f.name).trim().toLowerCase() === v.value.toLowerCase()
      );
      if (clash) return res.status(409).json({ message: `${block.name} already has a floor called "${clash.name}".`, code: "floor_exists" });
      floor.name = v.value;
    } else if (body.isActive === undefined) {
      const v = reqStr(body.name, "name", 120);
      return res.status(400).json({ message: v.message });
    }

    if (body.isActive !== undefined) floor.isActive = Boolean(body.isActive);

    await venue.save();
    return res.status(200).json(await layoutPayload(venue, { floor }));
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// ── DELETE /venues/:slug/room-blocks/:blockId/floors/:floorId ───────────────
// Same two refusals as a block, and for the same two reasons: deleting is a
// second act, and what happens to the rooms on it is said before it happens.
// A floor's rooms stay in the BLOCK — only the floor is lost — which is a
// smaller consequence than a block's, and still not one to discover afterwards.
const deleteFloor = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const block = (venue.blocks || []).id(req.params.blockId);
    if (!block) return res.status(404).json({ message: "Block not found" });
    const floor = (block.floors || []).id(req.params.floorId);
    if (!floor) return res.status(404).json({ message: "Floor not found" });

    if (floor.isActive !== false) {
      return res.status(409).json({
        code: "floor_active",
        message: `"${floor.name}" is still in use. Take it out of use first — deleting a floor cannot be undone.`,
        canDeactivate: true,
      });
    }

    const inside = (venue.rooms || []).filter((r) => idOf(r.floorRef) === idOf(floor._id));
    if (inside.length && String(req.query.force || "") !== "1") {
      return res.status(409).json({
        message: `${inside.length} room${inside.length === 1 ? " is" : "s are"} on ${floor.name}. Removing it leaves ${inside.length === 1 ? "it" : "them"} in ${block.name} with no floor.`,
        code: "floor_in_use",
        rooms: inside.map((r) => r.name),
        roomCount: inside.length,
      });
    }
    // They stay in the BLOCK — only the floor is gone. Dropping them all the
    // way to unplaced would lose information the owner did not ask to lose.
    for (const r of inside) r.floorRef = null;
    const name = floor.name;
    floor.deleteOne();
    await venue.save();
    return res.status(200).json(await layoutPayload(venue, {
      deleted: true, deletedName: name, keptInBlock: inside.length,
    }));
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// ── PUT /venues/:slug/room-blocks/order ─────────────────────────────────────
// Body: { blocks: [blockId, …] } or { blockId, floors: [floorId, …] }
//
// THE ARRAY IS THE ORDER, so reordering is a rewrite of the array, and the
// request must name EVERY id exactly once. A partial list would silently drop
// whatever it omitted — the one outcome a reorder must never have.
const reorder = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const body = req.body || {};

    if (Array.isArray(body.blocks)) {
      const want = body.blocks.map(String);
      const have = (venue.blocks || []).map((b) => idOf(b._id));
      const problem = sameSet(want, have);
      if (problem) return res.status(400).json({ message: `Blocks ${problem}`, code: "reorder_mismatch" });
      const byId = new Map((venue.blocks || []).map((b) => [idOf(b._id), b]));
      venue.blocks = want.map((id) => byId.get(id));
      await venue.save();
      return res.status(200).json(await layoutPayload(venue));
    }

    if (body.blockId && Array.isArray(body.floors)) {
      const block = (venue.blocks || []).id(body.blockId);
      if (!block) return res.status(404).json({ message: "Block not found" });
      const want = body.floors.map(String);
      const have = (block.floors || []).map((f) => idOf(f._id));
      const problem = sameSet(want, have);
      if (problem) return res.status(400).json({ message: `Floors ${problem}`, code: "reorder_mismatch" });
      const byId = new Map((block.floors || []).map((f) => [idOf(f._id), f]));
      block.floors = want.map((id) => byId.get(id));
      await venue.save();
      return res.status(200).json(await layoutPayload(venue));
    }

    return res.status(400).json({ message: "Send either blocks:[…] or blockId with floors:[…]." });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

/** Null when the two lists are the same set; a sentence naming the problem otherwise. */
function sameSet(want, have) {
  if (want.length !== have.length) return `must be listed in full — got ${want.length} of ${have.length}.`;
  const h = new Set(have);
  const seen = new Set();
  for (const id of want) {
    if (!h.has(id)) return "list contains something that is not here.";
    if (seen.has(id)) return "list repeats an entry.";
    seen.add(id);
  }
  return null;
}

// ── PATCH /venues/:slug/rooms/:roomId/place ─────────────────────────────────
// Move one room. Its own endpoint rather than a field on the room patch,
// because a placement is a pair that must be validated together — a floorRef
// from a different block is the failure this prevents.
const placeRoom = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const room = (venue.rooms || []).id(req.params.roomId);
    if (!room) return res.status(404).json({ message: "Room not found" });
    const body = req.body || {};
    const v = validatePlacement(venue, body.blockRef || null, body.floorRef || null);
    if (!v.ok) return res.status(400).json({ message: v.message });
    room.blockRef = v.value.blockRef;
    room.floorRef = v.value.floorRef;
    await venue.save();
    return res.status(200).json(await layoutPayload(venue, { roomId: room._id }));
  } catch (err) { return res.status(500).json({ message: err.message }); }
};


// ── PATCH /venues/:slug/rooms/:roomId/housekeeping ──────────────────────────
// Lives HERE, beside placeRoom, and not in venueRooms — because it must answer
// with the LAYOUT payload.
//
// It was written in venueRooms first and returned that controller's rooms-state
// shape. The drawer merged it straight into `layoutState`, which then had no
// `layout` key at all, and the entire floor plan disappeared from the screen.
// That is the ROOMS 3 defect exactly: a write endpoint returning a shape the
// read endpoint doesn't, merged into client state — flaky UI that never gets
// diagnosed. Same surface, same payload, no exceptions.
const setHousekeeping = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const room = venue.rooms.id(req.params.roomId);
    if (!room) return res.status(404).json({ message: "Room not found" });

    const status = (req.body || {}).status;
    if (!isValidStatus(status)) {
      return res.status(400).json({ message: `status must be one of ${HOUSEKEEPING_STATUSES.join(", ")}` });
    }

    // Any status, any time — see utils/venueHousekeeping. These are
    // observations about a physical room, not a workflow to enforce: a
    // supervisor who finds an "inspected" room filthy has to be able to say so.
    // WHO and WHEN is what makes the record worth having.
    room.housekeeping = { status, at: new Date(), byName: await housekeepingActorName(req) };
    await venue.save();

    return res.status(200).json(await layoutPayload(venue, { roomId: room._id }));
  } catch (err) { return res.status(500).json({ message: err.message }); }
};



// ── PUT/DELETE /venues/:slug/rooms/:roomId/out-of-order ─────────────────────
// Temporary and dated, as opposed to Deactivate which is permanent. Answers
// with the LAYOUT payload, like every other write on this surface.
const setOutOfOrder = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const room = venue.rooms.id(req.params.roomId);
    if (!room) return res.status(404).json({ message: "Room not found" });

    const b = req.body || {};
    const reason = String(b.reason || "").trim().slice(0, 200);
    // Required, deliberately. "Out of order" with no reason is a question
    // nobody downstream can answer — the same rule additional billing applies
    // to its label.
    if (!reason) return res.status(400).json({ message: "Say what's wrong with the room.", code: "reason_required" });

    const from = b.from ? new Date(b.from) : null;
    const to = b.to ? new Date(b.to) : null;
    if (!from || !to || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return res.status(400).json({ message: "A start and end date are required." });
    }
    const fromDay = ooDayStart(from);
    const toDay = ooDayStart(to);
    if (!(toDay > fromDay)) {
      return res.status(400).json({ message: "The end date has to be after the start date.", code: "bad_window" });
    }

    // ── THE COLLISION ────────────────────────────────────────────────────────
    // Rooms are reserved as a COUNT (ROOMS 1), so taking one out of order over
    // dates that already have held nights means the resort has promised more
    // rooms than it has. Warn, NAME the bookings, and let the owner proceed —
    // the same shape as rooms_short at confirmation and the deactivate guard.
    // Scoped to THIS window: holds outside it are not affected and warning
    // about them would train an owner to click through.
    const forced = String((req.query && req.query.force) || "") === "1" || b.acknowledgeHeldNights === true;
    if (!forced) {
      const held = await heldNightsForRoom(venue._id, room._id, { from: fromDay, to: toDay });
      if (held.upcoming > 0) {
        const who = held.bookings
          .map((x) => `${x.coupleName || "a booking"} (${x.nights} night${x.nights === 1 ? "" : "s"})`)
          .join(", ");
        return res.status(409).json({
          code: "room_has_held_nights",
          message:
            `"${room.name}" is promised to ${held.bookings.length} booking${held.bookings.length === 1 ? "" : "s"} ` +
            `in those dates — ${who}. Take it out of order anyway and ` +
            `${held.upcoming === 1 ? "that night" : "those nights"} will no longer have a room behind ${held.upcoming === 1 ? "it" : "them"}.`,
          upcoming: held.upcoming,
          bookings: held.bookings,
          acknowledgeWith: "acknowledgeHeldNights",
        });
      }
    }

    // Forced past it: the holds inside THIS WINDOW go, so the booking stops
    // believing it has a room it cannot be given. Nights carrying an allotment
    // are kept — moving a guest is the allotment flow's job.
    const released = await releaseHeldNightsForRoom(venue._id, room._id, { from: fromDay, to: toDay });

    room.outOfOrder = { reason, from: fromDay, to: toDay, at: new Date(), byName: await housekeepingActorName(req) };
    await venue.save();
    return res.status(200).json(await layoutPayload(venue, { roomId: room._id, releasedNights: released }));
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// Back in service. Never re-reserves anything: the holds released on the way in
// are gone, and silently re-taking rooms a booking was told it had lost would
// be a second opinion about inventory the owner has already re-planned around.
const clearOutOfOrder = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const room = venue.rooms.id(req.params.roomId);
    if (!room) return res.status(404).json({ message: "Room not found" });
    room.outOfOrder = undefined;
    await venue.save();
    return res.status(200).json(await layoutPayload(venue, { roomId: room._id }));
  } catch (err) { return res.status(500).json({ message: err.message }); }
};


module.exports = {
  setHousekeeping,
  setOutOfOrder,
  clearOutOfOrder,
  getSetup, skipShape, completeSetup, dismissSetup,
  getLayout, addBlock, updateBlock, deleteBlock,
  addFloor, updateFloor, deleteFloor,
  reorder, placeRoom, layoutPayload, resolveOwnedVenue,
};
