/**
 * controllers/venueAllotment.js — Phase 5 (PMS) room allotment lifecycle +
 * occupancy matrix.
 *
 * Double-booking guard: every active allotment owns one VenueRoomNight doc per
 * occupied night, protected by a UNIQUE (room, night) index. Creation inserts
 * the night docs FIRST; a duplicate-key failure means another allotment holds
 * (part of) the range, the partial insert is rolled back and the request 409s.
 * This is atomic under concurrency on a standalone Mongo — exactly one of N
 * simultaneous identical requests wins.
 */
const Venue = require("../models/Venue");
const VenueBooking = require("../models/VenueBooking");
const VenueRoomAllotment = require("../models/VenueRoomAllotment");
const VenueRoomNight = require("../models/VenueRoomNight");
const { reqStr, optStr, optDate } = require("../utils/venueInput");

async function resolveOwnedVenue(req, res, select = "_id rooms") {
  const venue = await Venue.findOne({ slug: req.params.slug }).select(select).lean();
  if (!venue) { res.status(404).json({ message: "Venue not found" }); return null; }
  if (String(venue._id) !== String(req.venueOwner.venueId)) { res.status(403).json({ message: "Forbidden" }); return null; }
  return venue;
}

// Midnight-UTC night keys for [checkInAt, checkOutAt): one per calendar night,
// minimum one (day-use). checkOut is the departure moment, so its own day is
// not occupied unless the stay is within a single day.
function nightKeys(checkInAt, checkOutAt) {
  const startDay = Date.UTC(checkInAt.getUTCFullYear(), checkInAt.getUTCMonth(), checkInAt.getUTCDate());
  const endDay = Date.UTC(checkOutAt.getUTCFullYear(), checkOutAt.getUTCMonth(), checkOutAt.getUTCDate());
  const nights = [];
  for (let t = startDay; t < endDay; t += 86400000) nights.push(new Date(t));
  if (nights.length === 0) nights.push(new Date(startDay));
  return nights;
}

function validateAllotmentInput(body) {
  const guestV = reqStr(body.guestName, "guestName", 200);
  if (!guestV.ok) return { error: guestV.message };
  const phoneV = optStr(body.guestPhone, "guestPhone", 30);
  if (!phoneV.ok) return { error: phoneV.message };
  const notesV = optStr(body.notes, "notes", 2000);
  if (!notesV.ok) return { error: notesV.message };
  const inV = optDate(body.checkInAt, "checkInAt");
  if (!inV.ok) return { error: inV.message };
  const outV = optDate(body.checkOutAt, "checkOutAt");
  if (!outV.ok) return { error: outV.message };
  if (!inV.value || !outV.value) return { error: "checkInAt and checkOutAt are required" };
  if (outV.value <= inV.value) return { error: "checkOutAt must be after checkInAt" };
  if (!body.room) return { error: "room is required" };
  return {
    value: {
      room: String(body.room),
      guestName: guestV.value,
      guestPhone: phoneV.value,
      notes: notesV.value,
      checkInAt: inV.value,
      checkOutAt: outV.value,
    },
  };
}

/**
 * Atomically claim the nights and create one allotment.
 * Returns { allotment } or { conflict } or { error }.
 */
async function createOneAllotment(venue, bookingId, input, ownerId) {
  const room = (venue.rooms || []).find((r) => String(r._id) === input.room);
  if (!room) return { error: "Room not found on this venue" };
  if (room.isActive === false) return { error: `Room "${room.name}" is inactive` };

  const allotment = new VenueRoomAllotment({
    venue: venue._id,
    booking: bookingId,
    room: room._id,
    guestName: input.guestName,
    guestPhone: input.guestPhone,
    notes: input.notes,
    checkInAt: input.checkInAt,
    checkOutAt: input.checkOutAt,
    status: "allotted",
    createdBy: ownerId,
  });

  const nights = nightKeys(input.checkInAt, input.checkOutAt).map((night) => ({
    venue: venue._id,
    room: room._id,
    night,
    allotment: allotment._id,
  }));

  try {
    // ordered:true → stops at the first duplicate; successfully inserted docs
    // before it are rolled back below.
    await VenueRoomNight.insertMany(nights, { ordered: true });
  } catch (e) {
    await VenueRoomNight.deleteMany({ allotment: allotment._id });
    if (e.code === 11000) {
      return { conflict: `Room "${room.name}" is already allotted for (part of) ${input.checkInAt.toISOString().slice(0, 10)} → ${input.checkOutAt.toISOString().slice(0, 10)}` };
    }
    throw e;
  }

  try {
    await allotment.save();
  } catch (e) {
    await VenueRoomNight.deleteMany({ allotment: allotment._id });
    throw e;
  }
  return { allotment };
}

// POST /venues/:slug/bookings/:bookingId/allotments — leads capability.
// Body: a single allotment object, or { allotments: [...] } for bulk.
const createAllotments = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const booking = await VenueBooking.findOne({ _id: req.params.bookingId, venue: venue._id }).select("_id").lean();
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    const raw = req.body || {};
    const inputs = Array.isArray(raw.allotments) ? raw.allotments : [raw];
    if (inputs.length === 0 || inputs.length > 50) {
      return res.status(400).json({ message: "1–50 allotments per request" });
    }

    const created = [];
    const conflicts = [];
    for (const item of inputs) {
      const v = validateAllotmentInput(item || {});
      if (v.error) {
        // Validation failure fails the whole request — nothing partial saved.
        for (const a of created) {
          await VenueRoomNight.deleteMany({ allotment: a._id });
          await VenueRoomAllotment.deleteOne({ _id: a._id });
        }
        return res.status(400).json({ message: v.error });
      }
      const result = await createOneAllotment(venue, booking._id, v.value, req.venueOwner.venueOwnerId);
      if (result.error) {
        for (const a of created) {
          await VenueRoomNight.deleteMany({ allotment: a._id });
          await VenueRoomAllotment.deleteOne({ _id: a._id });
        }
        return res.status(400).json({ message: result.error });
      }
      if (result.conflict) conflicts.push(result.conflict);
      else created.push(result.allotment);
    }

    if (created.length === 0 && conflicts.length > 0) {
      return res.status(409).json({ message: conflicts[0], conflicts });
    }
    return res.status(201).json({ allotments: created, conflicts });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// GET /venues/:slug/bookings/:bookingId/allotments — open read.
const listAllotments = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const allotments = await VenueRoomAllotment.find({ venue: venue._id, booking: req.params.bookingId })
      .sort({ checkInAt: 1 })
      .lean();
    const roomsById = Object.fromEntries((venue.rooms || []).map((r) => [String(r._id), r]));
    for (const a of allotments) a.roomDetail = roomsById[String(a.room)] || null;
    return res.status(200).json({ allotments });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// PATCH /venues/:slug/allotments/:allotmentId — leads capability.
// Body: { action: "check_in" | "check_out" | "cancel" } and/or { notes }.
const updateAllotment = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res, "_id");
    if (!venue) return;
    const allotment = await VenueRoomAllotment.findOne({ _id: req.params.allotmentId, venue: venue._id });
    if (!allotment) return res.status(404).json({ message: "Allotment not found" });

    const { action } = req.body || {};
    if (req.body && req.body.notes !== undefined) {
      const v = optStr(req.body.notes, "notes", 2000);
      if (!v.ok) return res.status(400).json({ message: v.message });
      allotment.notes = v.value;
    }

    if (action === "check_in") {
      if (allotment.status !== "allotted") return res.status(409).json({ message: `Cannot check in from status "${allotment.status}"` });
      allotment.status = "checked_in";
      allotment.actualCheckInAt = new Date();
    } else if (action === "check_out") {
      if (allotment.status !== "checked_in") return res.status(409).json({ message: `Cannot check out from status "${allotment.status}"` });
      allotment.status = "checked_out";
      allotment.actualCheckOutAt = new Date();
      // Early departure frees nights strictly after the actual check-out day.
      const out = allotment.actualCheckOutAt;
      const dayAfter = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth(), out.getUTCDate()) + 86400000);
      await VenueRoomNight.deleteMany({ allotment: allotment._id, night: { $gte: dayAfter } });
    } else if (action === "cancel") {
      if (allotment.status === "checked_out") return res.status(409).json({ message: "Cannot cancel a completed stay" });
      allotment.status = "cancelled";
      await VenueRoomNight.deleteMany({ allotment: allotment._id });
    } else if (action !== undefined) {
      return res.status(400).json({ message: "action must be check_in, check_out or cancel" });
    }

    await allotment.save();
    return res.status(200).json({ allotment });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// GET /venues/:slug/occupancy?from&to — open read. Rooms × days matrix.
const occupancy = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const fromV = optDate(req.query.from, "from");
    const toV = optDate(req.query.to, "to");
    if (!fromV.ok) return res.status(400).json({ message: fromV.message });
    if (!toV.ok) return res.status(400).json({ message: toV.message });
    const now = new Date();
    const from = fromV.value || new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const to = toV.value || new Date(from.getTime() + 14 * 86400000);
    if (to <= from) return res.status(400).json({ message: "to must be after from" });
    if (to - from > 92 * 86400000) return res.status(400).json({ message: "range too large (max 92 days)" });

    const allotments = await VenueRoomAllotment.find({
      venue: venue._id,
      status: { $in: ["allotted", "checked_in", "checked_out"] },
      checkInAt: { $lt: to },
      checkOutAt: { $gt: from },
    })
      .populate("booking", "coupleName status")
      .lean();

    const days = [];
    for (let t = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()); t < to.getTime(); t += 86400000) {
      days.push(new Date(t).toISOString().slice(0, 10));
    }
    const rooms = (venue.rooms || []).filter((r) => r.isActive !== false).map((r) => ({
      _id: r._id,
      name: r.name,
      type: r.type,
      capacity: r.capacity,
      allotments: allotments
        .filter((a) => String(a.room) === String(r._id))
        .map((a) => ({
          _id: a._id,
          booking: a.booking,
          guestName: a.guestName,
          status: a.status,
          checkInAt: a.checkInAt,
          checkOutAt: a.checkOutAt,
        })),
    }));

    return res.status(200).json({ from, to, days, rooms });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

module.exports = { createAllotments, listAllotments, updateAllotment, occupancy };
