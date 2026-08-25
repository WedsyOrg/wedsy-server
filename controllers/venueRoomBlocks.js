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
const { resolveRooms } = require("../utils/venueRoomTypes");

const SELECT = "_id slug rooms roomTypes roomAmenities accommodation blocks";

async function resolveOwnedVenue(req, res, select = SELECT) {
  const venue = await Venue.findOne({ slug: req.params.slug }).select(select);
  if (!venue) { res.status(404).json({ message: "Venue not found" }); return null; }
  if (String(venue._id) !== String(req.venueOwner.venueId)) { res.status(403).json({ message: "Forbidden" }); return null; }
  return venue;
}

const idOf = (v) => (v === null || v === undefined ? "" : String(v._id || v));

/** The whole shape, resolved, plus the rooms already inheritance-resolved. */
function layoutPayload(venue, extra = {}) {
  const byId = new Map(resolveRooms(venue).map((r) => [String(r._id), r]));
  const layout = resolveLayout(venue, { presentRoom: (r) => byId.get(String(r._id)) || r });
  return {
    blocks: venue.blocks || [],
    layout: layout.blocks,
    counts: layout.counts,
    roomTypes: venue.roomTypes || [],
    ...extra,
  };
}

// ── GET /venues/:slug/room-blocks ───────────────────────────────────────────
const getLayout = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    return res.status(200).json(layoutPayload(venue));
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
    return res.status(201).json(layoutPayload(venue, { block: created }));
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// ── PATCH /venues/:slug/room-blocks/:blockId ────────────────────────────────
// Rename only. Floors are their own endpoints; order is its own endpoint.
const updateBlock = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const block = (venue.blocks || []).id(req.params.blockId);
    if (!block) return res.status(404).json({ message: "Block not found" });
    const v = reqStr((req.body || {}).name, "name", 120);
    if (!v.ok) return res.status(400).json({ message: v.message });
    const clash = (venue.blocks || []).find(
      (b) => idOf(b._id) !== idOf(block._id) && String(b.name).trim().toLowerCase() === v.value.toLowerCase()
    );
    if (clash) return res.status(409).json({ message: `There is already a block called "${clash.name}".`, code: "block_exists" });
    block.name = v.value;
    await venue.save();
    return res.status(200).json(layoutPayload(venue, { block }));
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// ── DELETE /venues/:slug/room-blocks/:blockId ───────────────────────────────
// A block holding rooms is NOT removed silently: those rooms would land in the
// unplaced bucket with nothing on screen explaining why they moved. Refuse and
// name the count, unless the owner says so explicitly.
const deleteBlock = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const block = (venue.blocks || []).id(req.params.blockId);
    if (!block) return res.status(404).json({ message: "Block not found" });

    const inside = (venue.rooms || []).filter((r) => idOf(r.blockRef) === idOf(block._id));
    if (inside.length && String(req.query.force || "") !== "1") {
      return res.status(409).json({
        message: `${inside.length} room${inside.length === 1 ? " is" : "s are"} in ${block.name}. Removing it leaves ${inside.length === 1 ? "it" : "them"} unplaced.`,
        code: "block_in_use",
        rooms: inside.map((r) => r.name),
      });
    }
    for (const r of inside) { r.blockRef = null; r.floorRef = null; }
    block.deleteOne();
    await venue.save();
    return res.status(200).json(layoutPayload(venue, { deleted: true, unplaced: inside.length }));
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
    return res.status(201).json(layoutPayload(venue, { floor: block.floors[block.floors.length - 1] }));
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// ── PATCH /venues/:slug/room-blocks/:blockId/floors/:floorId ────────────────
const updateFloor = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const block = (venue.blocks || []).id(req.params.blockId);
    if (!block) return res.status(404).json({ message: "Block not found" });
    const floor = (block.floors || []).id(req.params.floorId);
    if (!floor) return res.status(404).json({ message: "Floor not found" });
    const v = reqStr((req.body || {}).name, "name", 120);
    if (!v.ok) return res.status(400).json({ message: v.message });
    const clash = (block.floors || []).find(
      (f) => idOf(f._id) !== idOf(floor._id) && String(f.name).trim().toLowerCase() === v.value.toLowerCase()
    );
    if (clash) return res.status(409).json({ message: `${block.name} already has a floor called "${clash.name}".`, code: "floor_exists" });
    floor.name = v.value;
    await venue.save();
    return res.status(200).json(layoutPayload(venue, { floor }));
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// ── DELETE /venues/:slug/room-blocks/:blockId/floors/:floorId ───────────────
const deleteFloor = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const block = (venue.blocks || []).id(req.params.blockId);
    if (!block) return res.status(404).json({ message: "Block not found" });
    const floor = (block.floors || []).id(req.params.floorId);
    if (!floor) return res.status(404).json({ message: "Floor not found" });

    const inside = (venue.rooms || []).filter((r) => idOf(r.floorRef) === idOf(floor._id));
    if (inside.length && String(req.query.force || "") !== "1") {
      return res.status(409).json({
        message: `${inside.length} room${inside.length === 1 ? " is" : "s are"} on ${floor.name}. Removing it leaves ${inside.length === 1 ? "it" : "them"} in ${block.name} with no floor.`,
        code: "floor_in_use",
        rooms: inside.map((r) => r.name),
      });
    }
    // They stay in the BLOCK — only the floor is gone. Dropping them all the
    // way to unplaced would lose information the owner did not ask to lose.
    for (const r of inside) r.floorRef = null;
    floor.deleteOne();
    await venue.save();
    return res.status(200).json(layoutPayload(venue, { deleted: true, keptInBlock: inside.length }));
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
      return res.status(200).json(layoutPayload(venue));
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
      return res.status(200).json(layoutPayload(venue));
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
    return res.status(200).json(layoutPayload(venue, { roomId: room._id }));
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

module.exports = {
  getLayout, addBlock, updateBlock, deleteBlock,
  addFloor, updateFloor, deleteFloor,
  reorder, placeRoom, layoutPayload, resolveOwnedVenue,
};
