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
const { resolveScopedBooking, bookingInScope } = require("../utils/venueBookingScope");
const VenueBooking = require("../models/VenueBooking");
const { findType, occupancyOf } = require("../utils/venueRoomTypes");
const VenueRoomAllotment = require("../models/VenueRoomAllotment");
const VenueRoomNight = require("../models/VenueRoomNight");
const VenueEnquiry = require("../models/VenueEnquiry");
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

  const nightList = nightKeys(input.checkInAt, input.checkOutAt);

  // ── TAKE OVER THIS BOOKING'S OWN HELD NIGHTS FIRST ───────────────────────
  // The booking already reserved a count at confirmation, so most of these
  // nights are sitting here HELD (allotment: null) against this very room.
  // Claiming fresh rows for them would collide with the booking's own
  // reservation, and deleting the held row first would open a gap another
  // booking could win.
  //
  // So the row is UPDATED in place. It never stops existing, which is what
  // keeps a booking that reserved 20 and allots 20 at 20 nights rather than 40.
  const takenOver = [];
  for (const night of nightList) {
    const swapped = await VenueRoomNight.findOneAndUpdate(
      { venue: venue._id, room: room._id, night, booking: bookingId, allotment: null },
      { $set: { allotment: allotment._id } },
      { new: true }
    ).lean();
    if (swapped) takenOver.push(night);
  }
  const takenOverKeys = new Set(takenOver.map((n) => Number(n)));

  // Anything not already held — a stay outside the reserved window, or a
  // booking that never reserved — is claimed the original way.
  const nights = nightList
    .filter((night) => !takenOverKeys.has(Number(night)))
    .map((night) => ({
      venue: venue._id,
      room: room._id,
      night,
      booking: bookingId,
      allotment: allotment._id,
    }));

  /** Put every swapped row back to HELD. The reservation must survive a failure. */
  const unswap = async () => {
    if (takenOver.length) {
      await VenueRoomNight.updateMany(
        { allotment: allotment._id, night: { $in: takenOver } },
        { $set: { allotment: null } }
      );
    }
  };

  try {
    // ordered:true → stops at the first duplicate; successfully inserted docs
    // before it are rolled back below.
    await VenueRoomNight.insertMany(nights, { ordered: true });
  } catch (e) {
    await VenueRoomNight.deleteMany({ allotment: allotment._id, night: { $nin: takenOver } });
    await unswap();
    if (e.code === 11000) {
      return { conflict: `Room "${room.name}" is already allotted for (part of) ${input.checkInAt.toISOString().slice(0, 10)} → ${input.checkOutAt.toISOString().slice(0, 10)}` };
    }
    throw e;
  }

  try {
    await allotment.save();
  } catch (e) {
    // Fresh rows go; taken-over rows go BACK TO HELD. Deleting them would
    // silently cancel part of the booking's reservation because a guest name
    // failed to save.
    await VenueRoomNight.deleteMany({ allotment: allotment._id, night: { $nin: takenOver } });
    await unswap();
    throw e;
  }
  return { allotment, takenOver };
}

/**
 * Undo one allotment WITHOUT touching the booking's reservation.
 *
 * Rows this allotment took over from the reservation revert to held; rows it
 * claimed itself are deleted. A plain deleteMany({allotment}) would do the
 * first job wrong and hand the nights to whoever asked next.
 */
async function undoAllotment(allotmentId, takenOver = []) {
  await VenueRoomNight.deleteMany({ allotment: allotmentId, night: { $nin: takenOver } });
  if (takenOver.length) {
    await VenueRoomNight.updateMany(
      { allotment: allotmentId, night: { $in: takenOver } },
      { $set: { allotment: null } }
    );
  }
  await VenueRoomAllotment.deleteOne({ _id: allotmentId });
}

// POST /venues/:slug/bookings/:bookingId/allotments — leads capability.
// Body: a single allotment object, or { allotments: [...] } for bulk.
const createAllotments = async (req, res) => {
  try {
    const owned = await resolveScopedBooking(req, res, "_id rooms");
    if (!owned) return;
    const venue = owned.venue;
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
        for (const a of created) await undoAllotment(a._id, a.takenOver);
        return res.status(400).json({ message: v.error });
      }
      const result = await createOneAllotment(venue, booking._id, v.value, req.venueOwner.venueOwnerId);
      if (result.error) {
        for (const a of created) await undoAllotment(a._id, a.takenOver);
        return res.status(400).json({ message: result.error });
      }
      if (result.conflict) conflicts.push(result.conflict);
      else {
        // The taken-over nights ride along, because rolling this allotment back
        // later must revert them to HELD rather than delete them — see
        // undoAllotment.
        created.push(Object.assign(result.allotment, { takenOver: result.takenOver || [] }));
      }
    }

    if (created.length === 0 && conflicts.length > 0) {
      return res.status(409).json({ message: conflicts[0], conflicts });
    }
    return res.status(201).json({ allotments: created, conflicts });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

/**
 * Booking→Rooms handoff (product-map dead-end #6).
 *
 * Resolve the accommodation requirement for a booking and the stay window it
 * should span. The window is the REAL event window — the lead's
 * checkIn→checkOut when set, else the booking's own day range. There are no
 * fixed-duration presets anywhere in this product: duration is computed from
 * the window, never chosen from a list.
 *
 * Returns { roomsNeeded, allotted, shortfall, window, leadId } or null when the
 * booking has no originating lead.
 */
async function roomsRequirementFor(venue, booking) {
  const lead = booking.enquiry
    ? await VenueEnquiry.findById(booking.enquiry).select("requirements checkIn checkOut eventDate coupleName name guestCount").lean()
    : null;

  // Live lead value wins over the booking snapshot, so editing the requirement
  // on the lead after booking still reaches the PMS.
  const roomsNeeded =
    (lead && lead.requirements && lead.requirements.roomsNeeded) || booking.roomsRequired || 0;

  const dayDates = (booking.days || []).map((d) => d.date).filter(Boolean).map((d) => new Date(d));
  let from = lead && lead.checkIn ? new Date(lead.checkIn) : dayDates.length ? new Date(Math.min(...dayDates)) : null;
  let to = lead && lead.checkOut ? new Date(lead.checkOut) : dayDates.length ? new Date(Math.max(...dayDates)) : null;
  // A single-day event still needs one night of inventory.
  if (from && to && to <= from) to = new Date(from.getTime() + 86400000);

  const allotted = await VenueRoomAllotment.countDocuments({
    venue: venue._id,
    booking: booking._id,
    status: { $in: ["allotted", "checked_in", "checked_out"] },
  });

  return {
    roomsNeeded,
    allotted,
    shortfall: Math.max(0, roomsNeeded - allotted),
    window: from && to ? { from, to, nights: nightKeys(from, to).length } : null,
    leadId: booking.enquiry || null,
    coupleName: (lead && (lead.coupleName || lead.name)) || booking.coupleName || "",
  };
}

// GET /venues/:slug/bookings/:bookingId/allotments — open read.
// Also answers "what did the couple actually ask for?" so Rooms/PMS is no
// longer an island the lead's requirement never reaches.
const listAllotments = async (req, res) => {
  try {
    // `roomTypes` because each allotment carries its room's extra-bed ceiling —
    // see below. Omitting it does not fail loudly; it makes every room look
    // unrestricted, which is the same missing-select shape that has bitten this
    // area repeatedly.
    const owned = await resolveScopedBooking(req, res, "_id rooms roomTypes");
    if (!owned) return;
    const venue = owned.venue;
    const booking = await VenueBooking.findOne({ _id: req.params.bookingId, venue: venue._id })
      .select("_id enquiry days roomsRequired coupleName")
      .lean();
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    const allotments = await VenueRoomAllotment.find({ venue: venue._id, booking: req.params.bookingId })
      .sort({ checkInAt: 1 })
      .lean();
    const roomsById = Object.fromEntries((venue.rooms || []).map((r) => [String(r._id), r]));
    for (const a of allotments) {
      a.roomDetail = roomsById[String(a.room)] || null;
      /**
       * ── THE CEILING TRAVELS WITH THE ALLOTMENT ───────────────────────────
       * So the check-in screen can SAY how many extra beds this room takes
       * before a clerk enters more, rather than letting them enter four and
       * be refused afterwards. Same principle as the type's `deleteAction`:
       * the verdict rides on the read, and the control is worded from it.
       *
       * `stated: false` means nobody has answered for this room's type, and
       * the screen must not invent a limit — the server does not enforce one
       * either.
       */
      const type = a.roomDetail ? findType(venue, a.roomDetail.typeRef) : null;
      const occ = type ? occupancyOf(type) : null;
      a.extraBeds = occ && occ.extraStated
        ? { stated: true, allowed: occ.extra, typeName: type.name || "" }
        : { stated: false, allowed: null, typeName: type ? type.name || "" : "" };
    }

    const requirement = await roomsRequirementFor(venue, booking);
    return res.status(200).json({ allotments, requirement });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// GET /venues/:slug/bookings/:bookingId/allotments/plan — the actionable half
// of the handoff. Proposes concrete FREE rooms covering the shortfall across
// the real stay window, without writing anything. The owner reviews and posts
// the plan back to the existing POST /allotments, so there is exactly one
// allotment-creation path and its atomic night-claiming still guards against
// double-booking.
const planAllotments = async (req, res) => {
  try {
    const owned = await resolveScopedBooking(req, res, "_id rooms");
    if (!owned) return;
    const venue = owned.venue;
    const booking = await VenueBooking.findOne({ _id: req.params.bookingId, venue: venue._id })
      .select("_id enquiry days roomsRequired coupleName couplePhone")
      .lean();
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    const requirement = await roomsRequirementFor(venue, booking);
    if (!requirement.window) {
      return res.status(409).json({ message: "This booking has no event dates yet — set the event window before planning rooms", requirement });
    }
    if (requirement.shortfall === 0) {
      return res.status(200).json({ requirement, plan: [], unavailable: 0, message: "Accommodation requirement is already covered" });
    }

    const { from, to } = requirement.window;
    const nights = nightKeys(from, to);

    // A room is offerable when it holds none of the required nights.
    const taken = new Set(
      (await VenueRoomNight.find({ venue: venue._id, night: { $in: nights } }).select("room night").lean())
        .map((n) => String(n.room))
    );
    const free = (venue.rooms || [])
      .filter((r) => r.isActive !== false && !taken.has(String(r._id)))
      // Smallest suitable room first, so a 20-room block does not eat the suites.
      .sort((a, b) => (a.capacity || 0) - (b.capacity || 0) || String(a.name).localeCompare(String(b.name)));

    const plan = free.slice(0, requirement.shortfall).map((r) => ({
      room: r._id,
      roomName: r.name,
      type: r.type,
      capacity: r.capacity,
      guestName: requirement.coupleName ? `${requirement.coupleName} — guest` : "Guest",
      guestPhone: booking.couplePhone || "",
      checkInAt: from,
      checkOutAt: to,
    }));

    return res.status(200).json({
      requirement,
      plan,
      // Honest about what could NOT be covered, rather than silently planning
      // fewer rooms than the couple asked for.
      unavailable: Math.max(0, requirement.shortfall - plan.length),
      nights: nights.length,
    });
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
    if (!(await bookingInScope(req, venue._id, allotment.booking))) {
      return res.status(404).json({ message: "Allotment not found" });
    }

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
          // Actuals let the client clip an early-departure stay to the real
          // occupied range instead of the planned one.
          actualCheckInAt: a.actualCheckInAt || null,
          actualCheckOutAt: a.actualCheckOutAt || null,
        })),
    }));

    return res.status(200).json({ from, to, days, rooms });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

module.exports = { createAllotments, listAllotments, planAllotments, updateAllotment, occupancy, roomsRequirementFor };
