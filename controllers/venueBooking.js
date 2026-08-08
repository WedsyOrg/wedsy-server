/**
 * controllers/venueBooking.js — Phase 3 (3.1) bookings.
 * CRUD under /venues/:slug/bookings (venueOwnerAuth + ownership).
 * Also exports createDraftBookingForEnquiry() for the booked-stage auto-create
 * hook and the quote→booking flow (idempotent: one booking per enquiry).
 *
 * MB-CRM-2 S2 — invariant #4 (ONE booking-creation path): every route that
 * turns a lead into a booking (quote-accept, stage→booked, and the CRM-2
 * Confirm Booking wizard via confirmBookingFromLead below) creates the booking
 * ONLY through createDraftBookingForEnquiry. The wizard endpoint layers
 * calendar blocking + payment schedule + agreement ON TOP of that shared
 * primitive — never a parallel create.
 */
const mongoose = require("mongoose");
const Venue = require("../models/Venue");
const VenueBooking = require("../models/VenueBooking");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueHold = require("../models/VenueHold");
const VenueSpaceDate = require("../models/VenueSpaceDate");
const { seedRunsheetForBooking } = require("../utils/venueRunsheet");
const { resolveScopedEnquiry } = require("../utils/venueLeadScope");
const { optStr, optNumber, optDate, optCount, MAXLEN } = require("../utils/venueInput");

async function resolveOwnedVenue(req, res, select = "_id") {
  const venue = await Venue.findOne({ slug: req.params.slug }).select(select).lean();
  if (!venue) { res.status(404).json({ message: "Venue not found" }); return null; }
  if (String(venue._id) !== String(req.venueOwner.venueId)) { res.status(403).json({ message: "Forbidden" }); return null; }
  return venue;
}

/**
 * Idempotently create a draft booking for an enquiry. Returns the booking doc.
 * Safe to call repeatedly (one booking per enquiry, enforced by unique index).
 */
async function createDraftBookingForEnquiry(venueId, enquiry, ownerId) {
  const existing = await VenueBooking.findOne({ enquiry: enquiry._id });
  if (existing) return existing;
  try {
    const booking = await VenueBooking.create({
      venue: venueId,
      enquiry: enquiry._id,
      coupleName: enquiry.coupleName || enquiry.name || "",
      couplePhone: enquiry.couplePhone || enquiry.phone || "",
      days: enquiry.eventDate ? [{ date: enquiry.eventDate, guestCount: enquiry.guestCount || 0 }] : [],
      totalValue: enquiry.estimatedValue || 0,
      // Carry the accommodation requirement across the lead→booking boundary
      // so Rooms/PMS inherits it (dead-end #6).
      roomsRequired: (enquiry.requirements && enquiry.requirements.roomsNeeded) || 0,
      status: "confirmed",
      createdBy: ownerId,
    });
    await seedRunsheetForBooking(booking); // default event-day skeleton per day
    return booking;
  } catch (e) {
    // Concurrent create lost the race on the unique index — return the winner.
    if (e.code === 11000) return VenueBooking.findOne({ enquiry: enquiry._id });
    throw e;
  }
}

const listBookings = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const bookings = await VenueBooking.find({ venue: venue._id }).sort({ createdAt: -1 }).lean();
    return res.status(200).json({ bookings, total: bookings.length });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

const getBooking = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const booking = await VenueBooking.findOne({ _id: req.params.bookingId, venue: venue._id }).lean();
    if (!booking) return res.status(404).json({ message: "Booking not found" });
    return res.status(200).json({ booking });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

const createBooking = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const { enquiry, coupleName, couplePhone, days, totalValue, paymentSchedule, specialRequirements, status } = req.body || {};
    const booking = await VenueBooking.create({
      venue: venue._id,
      enquiry: enquiry || undefined,
      coupleName: coupleName || "",
      couplePhone: couplePhone || "",
      days: Array.isArray(days) ? days : [],
      totalValue: Number(totalValue) || 0,
      paymentSchedule: Array.isArray(paymentSchedule) ? paymentSchedule : [],
      specialRequirements: specialRequirements || "",
      status: status || "confirmed",
      createdBy: req.venueOwner.venueOwnerId,
    });
    await seedRunsheetForBooking(booking); // default event-day skeleton per day
    return res.status(201).json({ booking });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: "A booking already exists for this enquiry" });
    return res.status(500).json({ message: err.message });
  }
};

const UPDATABLE = ["coupleName", "couplePhone", "days", "totalValue", "paymentSchedule", "specialRequirements", "status"];
const updateBooking = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const booking = await VenueBooking.findOne({ _id: req.params.bookingId, venue: venue._id });
    if (!booking) return res.status(404).json({ message: "Booking not found" });
    for (const k of UPDATABLE) {
      if (req.body[k] !== undefined) booking[k] = req.body[k];
    }
    await booking.save();
    // Newly added days get the default runsheet skeleton (no-op for existing).
    if (req.body.days !== undefined) await seedRunsheetForBooking(booking);
    return res.status(200).json({ booking });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// ── MB-CRM-2 S2: POST /venues/:slug/enquiries/:enquiryId/confirm-booking ──
// The Confirm Booking wizard's single write. Body:
//   functions: [{ date:"YYYY-MM-DD", space?: <Venue.spaces._id>, name?, pax? }]  (≥1)
//   tokenAmount?, tokenMode?, paymentSchedule?: [{ label, amount, dueDate }],
//   agreementDocId?, totalValue?
// Orchestration (bookings_money-gated at the route):
//   1. scoped lead resolve (404, never 403, for out-of-scope/deleted/missing)
//   2. refuse when this lead's booking already holds blocked calendar rows (409)
//   3. block each date-space: the lead's own approved-hold rows CONVERT to
//      booked; the rest insert atomically — any date-space someone else holds/
//      booked/blocked ⇒ full rollback + 409 (existing calendar semantics)
//   4. enrich the booking (days/schedule/token/agreement/totalValue) — the
//      booking itself comes from createDraftBookingForEnquiry (invariant #4)
//   5. stage=booked + timeline entry; booking↔lead resolvable both ways
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CONFIRM_FUNCTIONS = 20;
const MAX_SCHEDULE_ROWS = 12;

function parseConfirmDay(s) {
  if (typeof s !== "string" || !ISO_DAY_RE.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return null;
  return d;
}

const confirmBookingFromLead = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res, "_id name slug spaces settings blockedDates");
    if (!venue) return;

    const enquiry = await resolveScopedEnquiry(req.venueOwner, req.venueMember, venue._id, req.params.enquiryId);
    if (!enquiry) return res.status(404).json({ message: "Enquiry not found" });

    const body = req.body || {};

    // ── validate the blocks ──
    const fns = Array.isArray(body.functions) ? body.functions : [];
    if (fns.length === 0) return res.status(400).json({ message: "functions must list at least one date to block" });
    if (fns.length > MAX_CONFIRM_FUNCTIONS) return res.status(400).json({ message: `functions is too long (max ${MAX_CONFIRM_FUNCTIONS})` });
    const bookable = (venue.spaces || []).filter((s) => s.isBookable !== false);
    if (bookable.length === 0) return res.status(400).json({ message: "Venue has no bookable spaces" });
    const spaceById = new Map((venue.spaces || []).map((s) => [String(s._id), s]));
    const blocks = [];
    for (let i = 0; i < fns.length; i++) {
      const f = fns[i] || {};
      const day = parseConfirmDay(f.date);
      if (!day) return res.status(400).json({ message: `functions[${i}].date must be YYYY-MM-DD` });
      let spaces;
      if (f.space !== undefined && f.space !== null && f.space !== "") {
        const match = spaceById.get(String(f.space));
        if (!match) return res.status(400).json({ message: `functions[${i}].space is not a space of this venue` });
        if (match.isBookable === false) return res.status(400).json({ message: `functions[${i}].space is not bookable` });
        spaces = [match];
      } else {
        spaces = bookable; // venue-wide block, same semantics as holds
      }
      const paxV = optCount(f.pax, `functions[${i}].pax`);
      if (!paxV.ok) return res.status(400).json({ message: paxV.message });
      const nameV = optStr(f.name, `functions[${i}].name`, MAXLEN.label);
      if (!nameV.ok) return res.status(400).json({ message: nameV.message });
      blocks.push({ day, spaces, name: nameV.value, pax: paxV.value || 0 });
    }

    // Legacy venue-wide blocked dates win (same rule as approveHold).
    const legacyBlocked = (venue.blockedDates || []).filter((s) => blocks.some((b) => b.day.toISOString().slice(0, 10) === s));
    if (legacyBlocked.length > 0) {
      return res.status(409).json({ message: `Date(s) blocked on the venue calendar: ${legacyBlocked.join(", ")}` });
    }

    // ── validate the money + agreement ──
    const tokenV = optNumber(body.tokenAmount, "tokenAmount");
    if (!tokenV.ok) return res.status(400).json({ message: tokenV.message });
    const modeV = optStr(body.tokenMode, "tokenMode", MAXLEN.label);
    if (!modeV.ok) return res.status(400).json({ message: modeV.message });
    const schedRaw = Array.isArray(body.paymentSchedule) ? body.paymentSchedule : [];
    if (schedRaw.length > MAX_SCHEDULE_ROWS) return res.status(400).json({ message: `paymentSchedule is too long (max ${MAX_SCHEDULE_ROWS})` });
    const schedule = [];
    for (let i = 0; i < schedRaw.length; i++) {
      const row = schedRaw[i] || {};
      const lV = optStr(row.label, `paymentSchedule[${i}].label`, MAXLEN.label);
      if (!lV.ok) return res.status(400).json({ message: lV.message });
      const aV = optNumber(row.amount, `paymentSchedule[${i}].amount`);
      if (!aV.ok) return res.status(400).json({ message: aV.message });
      const dV = optDate(row.dueDate, `paymentSchedule[${i}].dueDate`);
      if (!dV.ok) return res.status(400).json({ message: dV.message });
      if (!lV.value && !aV.value) continue; // ignore fully-empty rows
      schedule.push({ label: lV.value, amount: aV.value || 0, dueDate: dV.value || undefined });
    }
    let agreementDoc;
    if (body.agreementDocId !== undefined && body.agreementDocId !== null && body.agreementDocId !== "") {
      if (!mongoose.isValidObjectId(body.agreementDocId)) {
        return res.status(400).json({ message: "agreementDocId is not a valid id" });
      }
      agreementDoc = body.agreementDocId;
    }
    const totalV = optNumber(body.totalValue, "totalValue");
    if (!totalV.ok) return res.status(400).json({ message: totalV.message });

    // ── already-booked refusal ──
    const existing = await VenueBooking.findOne({ enquiry: enquiry._id }).select("_id").lean();
    if (existing) {
      const alreadyBlocked = await VenueSpaceDate.countDocuments({ venue: venue._id, bookingRef: existing._id, state: "booked" });
      if (alreadyBlocked > 0) {
        return res.status(409).json({ message: "This lead already has a confirmed booking with blocked dates" });
      }
    }

    // ── the booking (single creation path — invariant #4) ──
    const booking = await createDraftBookingForEnquiry(venue._id, enquiry, req.venueOwner.venueOwnerId);

    // ── calendar blocking: convert the lead's own held rows, insert the rest ──
    const targetPairs = new Map(); // "space|day" -> { space, day }
    for (const b of blocks) {
      for (const s of b.spaces) {
        targetPairs.set(`${s._id}|${b.day.getTime()}`, { space: s._id, day: b.day });
      }
    }
    const leadHolds = await VenueHold.find({ venue: venue._id, linkedEnquiry: enquiry._id, status: "approved" }).select("_id").lean();
    const holdIds = leadHolds.map((h) => h._id);
    let converted = 0;
    const convertedRowIds = [];
    if (holdIds.length) {
      const heldRows = await VenueSpaceDate.find({ venue: venue._id, holdRef: { $in: holdIds }, state: "held" }).select("_id space date holdRef").lean();
      for (const r of heldRows) {
        if (targetPairs.has(`${r.space}|${new Date(r.date).getTime()}`)) convertedRowIds.push(r._id);
      }
      if (convertedRowIds.length) {
        const flip = await VenueSpaceDate.updateMany(
          { _id: { $in: convertedRowIds }, state: "held" },
          { $set: { state: "booked", bookingRef: booking._id } }
        );
        converted = flip.modifiedCount;
      }
    }
    const coveredKeys = new Set(
      (await VenueSpaceDate.find({ _id: { $in: convertedRowIds } }).select("space date").lean()).map(
        (r) => `${r.space}|${new Date(r.date).getTime()}`
      )
    );
    const batchRef = new mongoose.Types.ObjectId();
    const inserts = [];
    for (const [key, t] of targetPairs) {
      if (!coveredKeys.has(key)) inserts.push({ venue: venue._id, space: t.space, date: t.day, state: "booked", bookingRef: booking._id, batchRef });
    }
    if (inserts.length) {
      try {
        await VenueSpaceDate.insertMany(inserts, { ordered: true });
      } catch (e) {
        // Roll back everything this request did to the calendar, then 409.
        await VenueSpaceDate.deleteMany({ batchRef });
        if (convertedRowIds.length) {
          await VenueSpaceDate.updateMany({ _id: { $in: convertedRowIds } }, { $set: { state: "held" }, $unset: { bookingRef: 1 } });
        }
        if (e.code === 11000) {
          return res.status(409).json({ message: "One or more date-spaces are already held, booked, or blocked" });
        }
        throw e;
      }
    }

    // Consumed holds graduate: converted status; any leftover held rows are
    // released EXPLICITLY (logged below + counted in the response — never silent).
    let releasedLeftover = 0;
    if (convertedRowIds.length) {
      const touchedHolds = await VenueHold.find({ _id: { $in: holdIds } });
      for (const h of touchedHolds) {
        const stillHeld = await VenueSpaceDate.countDocuments({ holdRef: h._id, state: "held" });
        const gotConverted = await VenueSpaceDate.countDocuments({ holdRef: h._id, state: "booked", bookingRef: booking._id });
        if (gotConverted > 0) {
          if (stillHeld > 0) {
            const del = await VenueSpaceDate.deleteMany({ holdRef: h._id, state: "held" });
            releasedLeftover += del.deletedCount;
          }
          h.status = "converted";
          h.decidedAt = new Date();
          h.decidedBy = req.venueOwner.memberId ? "team member" : "owner";
          await h.save();
        }
      }
    }

    // ── enrich the booking ──
    const byDay = new Map();
    for (const b of blocks) {
      const k = b.day.getTime();
      if (!byDay.has(k)) byDay.set(k, { date: b.day, names: [], pax: 0, spaces: new Set() });
      const d = byDay.get(k);
      if (b.name) d.names.push(b.name);
      d.pax = Math.max(d.pax, b.pax || 0);
      for (const s of b.spaces) d.spaces.add(s.name || "");
    }
    booking.days = [...byDay.values()]
      .sort((a, b) => a.date - b.date)
      .map((d) => ({ date: d.date, eventType: d.names.join(" + "), guestCount: d.pax || enquiry.guestCount || 0, spaces: [...d.spaces].filter(Boolean) }));
    const token = tokenV.value || 0;
    const rows = [];
    if (token > 0) rows.push({ label: `Token — received${modeV.value ? ` (${modeV.value})` : ""}`, dueDate: new Date(), amount: token });
    rows.push(...schedule);
    if (rows.length) booking.paymentSchedule = rows;
    const computedTotal = token + schedule.reduce((s, r) => s + (r.amount || 0), 0);
    if (totalV.value !== undefined) booking.totalValue = totalV.value;
    else if (computedTotal > 0) booking.totalValue = computedTotal;
    if (agreementDoc) booking.agreementDoc = agreementDoc;
    booking.status = "confirmed";
    await booking.save();
    await seedRunsheetForBooking(booking);

    // ── the lead graduates ──
    const blockedCount = converted + inserts.length;
    const summary =
      `BOOKED — ${blocks.length} function(s), ${blockedCount} date-space(s) blocked on the calendar.` +
      (token > 0 ? ` Token ₹${token.toLocaleString("en-IN")}${modeV.value ? ` (${modeV.value})` : ""}.` : "") +
      (agreementDoc ? " Agreement on file." : "") +
      (releasedLeftover > 0 ? ` ${releasedLeftover} unused held date-space(s) released with the confirmation.` : "");
    if (enquiry.stage !== "booked") {
      enquiry.activities.push({
        type: "stage_changed",
        description: `Stage changed from ${enquiry.stage} to booked`,
        via: "confirm_booking",
        actor: req.venueOwner.memberId || req.venueOwner.venueOwnerId || null,
        timestamp: new Date(),
      });
      enquiry.stage = "booked";
    }
    if (booking.totalValue > 0) enquiry.estimatedValue = booking.totalValue;
    enquiry.notes.push({ text: summary, addedAt: new Date() });
    await enquiry.save();

    return res.status(200).json({
      booking,
      enquiry: { _id: enquiry._id, stage: enquiry.stage },
      blocked: blockedCount,
      converted,
      releasedLeftover,
    });
  } catch (err) {
    if (err.name === "ValidationError") return res.status(400).json({ message: err.message });
    return res.status(500).json({ message: err.message });
  }
};

module.exports = {
  createDraftBookingForEnquiry,
  listBookings,
  getBooking,
  createBooking,
  updateBooking,
  confirmBookingFromLead,
};
