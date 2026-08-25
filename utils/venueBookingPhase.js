/**
 * utils/venueBookingPhase.js — where a booking is IN TIME, derived.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * `booking.status` offered four values as equal choices: confirmed,
 * in_progress, completed, cancelled. Two of those are not decisions. "In
 * progress" means the event is happening now; "completed" means it has passed.
 * The system holds the dates, so it already knows — and an owner marking an
 * event Completed 35 days early with one click is a state the product should
 * not permit.
 *
 * An audit of the server before writing this found that NOTHING reads either
 * value. Every consumer — venuePayment, venueDashboard, venueOwner,
 * venueAnalytics, venuePricingIntel — tests only `status !== "cancelled"`. So
 * deriving them breaks no consumer, because there were none.
 *
 * ── CANCELLED IS NOT DERIVED, AND NEVER WILL BE ─────────────────────────────
 * It is the one genuine decision in the set, and the only one with a cascade
 * behind it. It stays manual — but deliberate, which is what
 * describeCancellation is for.
 */
const VenueRoomNight = require("../models/VenueRoomNight");
const VenueRoomAllotment = require("../models/VenueRoomAllotment");
const { roomNightOwnerFilter } = require("./venueRoomNights");
const { venueDateKey } = require("./venueTime");

/** Day keys, compared in UTC — the same basis the day rows are stored on. */
const dayKey = (d) => {
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString().slice(0, 10);
};

/**
 * confirmed → upcoming, in_progress → today, completed → past.
 *
 * Read from `days[]`, which is where the event actually lives. A booking with
 * no dates stays `confirmed`: "upcoming" is the honest answer when nothing says
 * otherwise, and guessing `completed` would archive a booking nobody had dated.
 */
function derivePhase(booking, now = new Date()) {
  if (!booking) return { phase: "confirmed", label: "Confirmed", derived: false };
  if (booking.status === "cancelled") {
    return { phase: "cancelled", label: "Cancelled", derived: false };
  }
  const keys = (booking.days || []).map((d) => d && d.date).filter(Boolean).map(dayKey).filter(Boolean).sort();
  if (!keys.length) return { phase: "confirmed", label: "Confirmed", derived: false };

  // ── "TODAY" IS THE VENUE'S TODAY, NOT UTC'S ──────────────────────────────
  // Event days are stored as UTC day keys, but the person reading this is in
  // Asia/Kolkata. Comparing against a UTC today means that between midnight and
  // 05:30 IST on the morning of the event the phase still reads "Confirmed" —
  // an off-by-one on precisely the day it matters most.
  const today = venueDateKey(now);
  const first = keys[0];
  const last = keys[keys.length - 1];

  if (today < first) return { phase: "confirmed", label: "Confirmed", derived: true, first, last };
  if (today > last) return { phase: "completed", label: "Completed", derived: true, first, last };
  return { phase: "in_progress", label: "Happening now", derived: true, first, last };
}

/**
 * WHAT CANCELLING WOULD RELEASE — named before it happens.
 *
 * THE PREVIEW AND THE APPLY CALL THIS SAME FUNCTION. The dates and the room
 * count an owner is shown in the confirmation are counted by the query the
 * cascade itself is about to run, not by a second estimate that could disagree.
 * A confirmation that says "3 nights" and then releases 5 is worse than no
 * confirmation at all.
 */
async function describeCancellation(booking) {
  const ownerFilter = await roomNightOwnerFilter(booking._id);
  const [nights, allotments] = await Promise.all([
    VenueRoomNight.find(ownerFilter).select("night room").lean(),
    VenueRoomAllotment.find({ booking: booking._id, status: { $in: ["allotted", "checked_in"] } })
      .select("_id room guestName")
      .lean(),
  ]);

  // `night` is the field — models/VenueRoomNight stores midnight UTC of the
  // occupied night. Reading `date` here returned undefined for every row, so
  // the confirmation promised a room-night COUNT while naming no dates at all.
  const dates = [...new Set(nights.map((n) => dayKey(n.night)).filter(Boolean))].sort();
  const rooms = new Set(nights.map((n) => String(n.room)).filter(Boolean));
  const eventDays = [...new Set((booking.days || []).map((d) => d && d.date).filter(Boolean).map(dayKey).filter(Boolean))].sort();

  return {
    roomNights: nights.length,
    /** Distinct rooms whose nights would be given back. */
    rooms: rooms.size,
    /** The nights themselves, so the confirmation can name the dates. */
    dates,
    allotments: allotments.length,
    /** The calendar days the booking holds, released with it. */
    eventDates: eventDays,
    /** Nothing to release is a real answer, and the screen should say it. */
    releasesNothing: nights.length === 0 && allotments.length === 0,
  };
}

module.exports = { derivePhase, describeCancellation, dayKey };
