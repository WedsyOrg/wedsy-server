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
const { wholeVenueSpaceIds, isWholeVenueSpace } = require("../utils/venueWholeVenue");
const { windowDays, applyWindowChange } = require("../utils/venueEventWindow");
const { PAYMENT_MODES, normaliseMode, modeLabel } = require("../utils/venuePaymentMode");
const { mergeClientIntoContacts } = require("../utils/venueClientContact");
const { sanitizeContacts } = require("../utils/venueContacts");
const { seedRunsheetForBooking } = require("../utils/venueRunsheet");
const { resolveScopedEnquiry } = require("../utils/venueLeadScope");
const { optStr, optNumber, optDate, optCount, MAXLEN, eventWindow } = require("../utils/venueInput");
const { venueDateKey, endOfVenueDay } = require("../utils/venueTime");

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

// ── PATCH /venues/:slug/bookings/:bookingId/window ──────────────────────────
// The booking side of the ONE window. The lead's PATCH and this endpoint are
// the same edit seen from two screens: both write both copies and both
// re-derive calendar inventory, through utils/venueEventWindow.
//
// This is the path the lead's old refusal used to point at — "change the dates
// through the booking, not the lead" — which never existed. It does now, and
// the lead's own path works too, because they are not two different dates.
//
// Body: { checkIn, checkOut, acknowledgeStaleHolds? }
const updateBookingWindow = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res, "_id name slug spaces settings blockedDates");
    if (!venue) return;

    const booking = await VenueBooking.findOne({ _id: req.params.bookingId, venue: venue._id });
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    // The lead is resolved through venueLeadScope, so a member who cannot see
    // this lead cannot move its dates from the booking screen either — 404,
    // never 403, exactly as every other lead read behaves.
    if (!booking.enquiry) {
      return res.status(400).json({
        message: "This booking is not linked to a lead, so its window cannot be kept in step.",
        code: "no_linked_lead",
      });
    }
    const enquiry = await resolveScopedEnquiry(req.venueOwner, req.venueMember, venue._id, booking.enquiry);
    if (!enquiry) return res.status(404).json({ message: "Booking not found" });

    const win = eventWindow((req.body || {}).checkIn, (req.body || {}).checkOut);
    if (!win.ok) return res.status(400).json({ message: win.message });
    if (!win.checkIn || !win.checkOut) {
      return res.status(400).json({
        message: "A booking needs both a check-in and a check-out — it is already sold.",
        code: "window_required",
      });
    }

    const result = await applyWindowChange({
      venue,
      enquiry,
      booking,
      checkIn: win.checkIn,
      checkOut: win.checkOut,
      acknowledgeStaleHolds: (req.body || {}).acknowledgeStaleHolds === true,
    });
    if (!result.ok) return res.status(result.status).json(result.body);

    enquiry.activities.push({
      type: "dates_changed",
      description:
        `Event window moved to ${venueDateKey(win.checkIn)} → ${venueDateKey(win.checkOut)} from the booking` +
        ` · calendar re-derived (+${result.calendar.added} / −${result.calendar.removed} date-spaces)`,
      actor: req.venueOwner ? req.venueOwner.memberId || req.venueOwner.venueOwnerId : null,
      timestamp: new Date(),
    });
    await enquiry.save();

    return res.status(200).json({
      success: true,
      booking: { _id: booking._id, checkIn: booking.checkIn, checkOut: booking.checkOut },
      enquiry: { _id: enquiry._id, checkIn: enquiry.checkIn, checkOut: enquiry.checkOut, eventDate: enquiry.eventDate },
      calendar: { added: result.calendar.added, removed: result.calendar.removed, kept: result.calendar.kept },
    });
  } catch (err) {
    if (err.name === "ValidationError") return res.status(400).json({ message: err.message });
    return res.status(500).json({ message: err.message });
  }
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
  // Reported back so the portal can say "added to People" rather than leaving
  // the owner to go and check whether their new contact actually landed.
  let clientSync = null;
  let clientWarnings = [];
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
    // A venue with no spaces defined can still sell the WHOLE PROPERTY — which
    // is normal for a wedding, and was previously refused outright. The
    // sentinel row carries the claim on its own in that case; see
    // utils/venueWholeVenue.js on why a sentinel alone is not enough once real
    // spaces exist.
    const wantsAnyNamedSpace = fns.some((f) => f && f.space !== undefined && f.space !== null && f.space !== "");
    if (bookable.length === 0 && wantsAnyNamedSpace) {
      return res.status(400).json({ message: "Venue has no bookable spaces" });
    }
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
        // ENTIRE PROPERTY. Every bookable space PLUS the sentinel, so the
        // existing unique {venue, space, date} index refuses an individual
        // space on this date and refuses a second whole-property claim —
        // structurally, not by an application check. The sentinel is also what
        // lets a space added later be backfilled onto this date.
        spaces = wholeVenueSpaceIds(venue).map((id) => spaceById.get(String(id)) || { _id: id });
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
    // A TOKEN IS A PAYMENT, so it is described the same way every other payment
    // is: the shared paidMode vocabulary, an optional reference (UTR, cheque
    // no.), and an optional note. Previously the mode arrived as free text and
    // was pattern-matched against the enum — anything that did not match was
    // dropped to "", so "Gpay" or "paytm" recorded a token with NO method at
    // all. Now an unrecognised value is refused rather than silently discarded,
    // and "other" exists precisely so there is somewhere legitimate for it.
    const modeOtherV = optStr(body.tokenModeOther, "tokenModeOther", MAXLEN.label);
    if (!modeOtherV.ok) return res.status(400).json({ message: modeOtherV.message });
    const refV = optStr(body.tokenReference, "tokenReference", MAXLEN.label);
    if (!refV.ok) return res.status(400).json({ message: refV.message });
    const noteV = optStr(body.tokenNote, "tokenNote", MAXLEN.notes || MAXLEN.label);
    if (!noteV.ok) return res.status(400).json({ message: noteV.message });
    const tokenMode = normaliseMode(modeV.value);
    if (modeV.value && tokenMode === null) {
      return res.status(400).json({
        message: `tokenMode must be one of ${PAYMENT_MODES.join(", ")} — use "other" and tokenModeOther for anything else`,
      });
    }
    // What a human should read. For "other" that is the name they typed, since
    // "(other)" tells the next person nothing.
    const tokenModeLabel = modeLabel(tokenMode, modeOtherV.value);
    // DECLARED HERE, WITH THE OTHER MONEY VALIDATORS, AND NOT LOWER DOWN.
    // The 100%-rule guard inside the schedule block below reads totalV. When
    // this `const` lived after that block it was a temporal dead zone: the
    // guard ran first and threw "Cannot access 'totalV' before initialization"
    // — a 500 on the one path the guard existed to protect. Keeping every
    // body validator in one place is what stops that recurring.
    const totalV = optNumber(body.totalValue, "totalValue");
    if (!totalV.ok) return res.status(400).json({ message: totalV.message });
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
      const pV = optNumber(row.percent, `paymentSchedule[${i}].percent`);
      if (!pV.ok) return res.status(400).json({ message: pV.message });
      if (!lV.value && !aV.value && pV.value === undefined) continue; // ignore fully-empty rows
      schedule.push({
        label: lV.value,
        amount: aV.value || 0,
        dueDate: dV.value || undefined,
        percent: pV.value === undefined ? null : pV.value,
      });
    }

    // ── S2: THE 100% RULE, ENFORCED SERVER-SIDE ─────────────────────────────
    // The wizard shows a live shortfall/excess while the owner adjusts, but the
    // rule cannot live only in the UI: this endpoint is the write, and a schedule
    // that does not add up is a schedule the venue cannot invoice against.
    //
    // Only enforced when percentages are actually in play. A schedule entered as
    // amounts only (every pre-existing caller, and an owner working in rupees)
    // is untouched — requiring percentages here would break a shape that already
    // works and was never wrong.
    const withPercent = schedule.filter((r) => r.percent !== null && r.percent !== undefined);
    if (withPercent.length) {
      if (withPercent.length !== schedule.length) {
        return res.status(400).json({
          message: "Give every instalment a percentage, or none of them — a half-percentage schedule cannot be checked.",
          code: "mixed_percent_schedule",
        });
      }
      const { checkTotal, toHundredths, ScheduleError } = require("../utils/venuePaymentSchedule");
      let total;
      try {
        total = checkTotal(withPercent.map((r, i) => ({ percentHundredths: toHundredths(r.percent, `paymentSchedule[${i}].percent`) })));
      } catch (e) {
        if (e instanceof ScheduleError) return res.status(400).json({ message: e.message, code: e.code });
        throw e;
      }
      if (!total.ok) {
        return res.status(400).json({
          message: `The schedule ${total.message.toLowerCase()} — it must total exactly 100% before it can be saved.`,
          code: "schedule_not_100",
          totalPercent: total.totalPercent,
          deltaPercent: total.deltaPercent,
        });
      }

      // ADVANCE + INSTALMENTS MUST EQUAL THE BOOKING VALUE.
      //
      // Percentages totalling 100 is not the same as the money adding up: the
      // percentages now apply to the BALANCE after the advance, so a client
      // that still splits the full booking value produces rows totalling 100%
      // that overshoot. That is not hypothetical — it is what shipped. A
      // ₹1,00,000 booking with a ₹25,000 token and a 50/50 shape stored
      // ₹25,000 paid plus ₹50,000 + ₹50,000 due: ₹1,25,000 scheduled against a
      // ₹1,00,000 booking, with the outstanding reading the full price on a
      // booking that already had a quarter of it in hand.
      //
      // Checked only when the caller states the booking value. An amounts-only
      // schedule with no declared total still derives it, exactly as before.
      if (totalV.value !== undefined) {
        const tokenNow = tokenV.value || 0;
        const scheduled = schedule.reduce((sum, r) => sum + (r.amount || 0), 0);
        if (tokenNow + scheduled !== totalV.value) {
          return res.status(400).json({
            message:
              `The advance and the instalments come to ${tokenNow + scheduled}, but the booking is ${totalV.value}. ` +
              `The percentages apply to the ${totalV.value - tokenNow} balance after the advance.`,
            code: "schedule_value_mismatch",
            bookingValue: totalV.value,
            advanceAmount: tokenNow,
            balance: totalV.value - tokenNow,
            scheduledAmount: scheduled,
          });
        }
      }
    }
    let agreementDoc;
    if (body.agreementDocId !== undefined && body.agreementDocId !== null && body.agreementDocId !== "") {
      if (!mongoose.isValidObjectId(body.agreementDocId)) {
        return res.status(400).json({ message: "agreementDocId is not a valid id" });
      }
      agreementDoc = body.agreementDocId;
    }

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

    // ── calendar blocking: the WINDOW is what is sold ──────────────────────
    // Every venue-day in [checkIn, checkOut] is blocked, not merely the days
    // carrying a function. A window of 29 Sept → 1 Oct with functions on the
    // 30th and 1st used to leave the 29th sellable while the couple had the
    // venue; a window nobody enforces is decorative.
    //
    // Spaces are the UNION across the booking's functions: the couple holds
    // those spaces for the whole window, not only on the day each is used.
    const targetPairs = new Map(); // "space|day" -> { space, day }
    if (enquiry.checkIn && enquiry.checkOut) {
      // The couple holds these spaces for the WHOLE window, not only on the day
      // each one is used, so the union of function spaces is claimed across
      // every day of the window.
      const spaceUnion = new Map();
      for (const b of blocks) for (const s of b.spaces) spaceUnion.set(String(s._id), s._id);
      for (const day of windowDays(enquiry.checkIn, enquiry.checkOut)) {
        for (const s of spaceUnion.values()) targetPairs.set(`${s}|${day.getTime()}`, { space: s, day });
      }
    } else {
      // No finalised window — nothing has been sold beyond the functions
      // themselves, so block exactly those date-spaces, as before. Widening
      // this would take inventory from leads the ruling says nothing about.
      for (const b of blocks) {
        for (const s of b.spaces) targetPairs.set(`${s._id}|${b.day.getTime()}`, { space: s._id, day: b.day });
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
      // A whole-property block is ONE fact, not a list of every space. Listing
      // them would also read identically to "they happened to tick all of
      // them", and those two diverge the moment a space is added.
      if (b.spaces.some((s) => isWholeVenueSpace(s._id))) d.spaces.add("Entire property");
      else for (const s of b.spaces) d.spaces.add(s.name || "");
    }
    booking.days = [...byDay.values()]
      .sort((a, b) => a.date - b.date)
      .map((d) => ({ date: d.date, eventType: d.names.join(" + "), guestCount: d.pax || enquiry.guestCount || 0, spaces: [...d.spaces].filter(Boolean) }));

    // ── the window comes across with the booking ───────────────────────────
    // The lead's window IS the booking's window. Confirming used to drop it,
    // leaving days[] as the only record of "when" and losing any part of the
    // window no function happened to sit on. When the lead has no finalised
    // window the function days ARE the window, so it is derived from them and
    // the two still agree.
    if (enquiry.checkIn && enquiry.checkOut) {
      booking.checkIn = enquiry.checkIn;
      booking.checkOut = enquiry.checkOut;
    } else if (booking.days.length) {
      const first = booking.days[0].date;
      const last = booking.days[booking.days.length - 1].date;
      booking.checkIn = first;
      // End of the last event day ON THE VENUE'S CALENDAR, so a single-day
      // booking reads as a window rather than a zero-length instant — and does
      // not spill into the following day. Plain "+24h − 1ms" lands at
      // 23:59:59.999Z, which in IST is already 05:29 the NEXT morning, so the
      // window would silently claim a day the couple never bought.
      booking.checkOut = endOfVenueDay(new Date(last));
    }
    const token = tokenV.value || 0;
    const rows = [];
    if (token > 0) {
      // The token is money already in hand, so it is recorded as a PAID row
      // rather than a due one — S4 reads paidAmount, and a token that shows as
      // outstanding would put the booking permanently in arrears on day one.
      // The label reads back what the owner chose, and for "other" that means
      // the name they typed — "Token — received (other)" would be worse than
      // saying nothing.
      rows.push({
        label: `Token — received${tokenModeLabel ? ` (${tokenModeLabel})` : ""}`,
        dueDate: new Date(),
        amount: token,
        percent: null,
        paidAmount: token,
        paidAt: new Date(),
        paidMode: tokenMode,
        paidModeOther: tokenMode === "other" ? modeOtherV.value || "" : "",
        paidReference: refV.value || "",
        paidNote: noteV.value || "",
        recordedBy: req.venueOwner ? req.venueOwner.memberId || req.venueOwner.venueOwnerId : null,
      });
    }
    rows.push(...schedule);
    if (rows.length) booking.paymentSchedule = rows;
    const computedTotal = token + schedule.reduce((s, r) => s + (r.amount || 0), 0);
    if (totalV.value !== undefined) booking.totalValue = totalV.value;
    else if (computedTotal > 0) booking.totalValue = computedTotal;
    if (agreementDoc) booking.agreementDoc = agreementDoc;

    // ── THE CLIENT STEP, WRITTEN INTO contacts[] AND NOWHERE ELSE ───────────
    // No `client` subdocument on the booking. The lead's contacts[] is the one
    // people model, so the wizard upserts into it (utils/venueClientContact)
    // and the result goes through the PEOPLE TAB'S OWN sanitizer — same
    // validation, same primary-contact rule, same GSTIN normalisation. A
    // client added here is therefore in People the moment the booking exists,
    // because it is the same array.
    if (body.client && typeof body.client === "object") {
      const merged = mergeClientIntoContacts(enquiry.contacts, body.client);
      if (merged.index >= 0) {
        const cV = sanitizeContacts(merged.contacts, enquiry.eventType);
        if (!cV.ok) return res.status(400).json({ message: `client — ${cV.message}` });
        enquiry.contacts = cV.value;
        clientSync = { matchedBy: merged.matchedBy, created: merged.created };
        if (cV.warnings && cV.warnings.length) clientWarnings = cV.warnings;
      }
    }

    booking.status = "confirmed";
    await booking.save();
    await seedRunsheetForBooking(booking);

    // ── the lead graduates ──
    const blockedCount = converted + inserts.length;
    const summary =
      `BOOKED — ${blocks.length} function(s), ${blockedCount} date-space(s) blocked on the calendar.` +
      (token > 0 ? ` Token ₹${token.toLocaleString("en-IN")}${tokenModeLabel ? ` (${tokenModeLabel})` : ""}.` : "") +
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
      // What happened to the client's contact, so the success panel can say
      // "added to People" instead of leaving the owner to go and check.
      clientSync,
      // Non-blocking notes — a GSTIN whose check digit looks wrong is worth
      // re-reading, and is never a reason to refuse a confirmed booking.
      clientWarnings,
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
  updateBookingWindow,
};
