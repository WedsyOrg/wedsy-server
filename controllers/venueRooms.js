/**
 * controllers/venueRooms.js — Phase 5 (PMS) rooms inventory CRUD.
 * Lives on Venue.rooms[] (venue-owned subdocs). Writes are listing-gated at
 * the route; reads are open to any authenticated venue identity.
 */
const Venue = require("../models/Venue");
const VenueRoomAllotment = require("../models/VenueRoomAllotment");
const { reqStr, optStr, optCount } = require("../utils/venueInput");

const ROOM_TYPES = ["standard", "deluxe", "suite", "dorm", "other"];

async function resolveOwnedVenue(req, res, select = "_id rooms") {
  const venue = await Venue.findOne({ slug: req.params.slug }).select(select);
  if (!venue) { res.status(404).json({ message: "Venue not found" }); return null; }
  if (String(venue._id) !== String(req.venueOwner.venueId)) { res.status(403).json({ message: "Forbidden" }); return null; }
  return venue;
}

function validateRoomInput(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.name !== undefined) {
    const v = reqStr(body.name, "name", 200);
    if (!v.ok) return { error: v.message };
    out.name = v.value;
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
  if (body.notes !== undefined) {
    const v = optStr(body.notes, "notes", 2000);
    if (!v.ok) return { error: v.message };
    out.notes = v.value;
  }
  if (body.isActive !== undefined) out.isActive = Boolean(body.isActive);
  return { value: out };
}

// GET /venues/:slug/rooms — open read (all roles).
const listRooms = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    return res.status(200).json({ rooms: venue.rooms || [] });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// POST /venues/:slug/rooms — listing capability.
const addRoom = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const v = validateRoomInput(req.body || {});
    if (v.error) return res.status(400).json({ message: v.error });
    venue.rooms.push(v.value);
    await venue.save();
    return res.status(201).json({ room: venue.rooms[venue.rooms.length - 1], rooms: venue.rooms });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// PATCH /venues/:slug/rooms/:roomId — listing capability.
const updateRoom = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const room = venue.rooms.id(req.params.roomId);
    if (!room) return res.status(404).json({ message: "Room not found" });
    const v = validateRoomInput(req.body || {}, { partial: true });
    if (v.error) return res.status(400).json({ message: v.error });
    Object.assign(room, v.value);
    await venue.save();
    return res.status(200).json({ room, rooms: venue.rooms });
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
      await venue.save();
      return res.status(200).json({ deactivated: true, rooms: venue.rooms });
    }
    room.deleteOne();
    await venue.save();
    return res.status(200).json({ deleted: true, rooms: venue.rooms });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

module.exports = { listRooms, addRoom, updateRoom, deleteRoom };
