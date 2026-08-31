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
const VenueRoomAllotment = require("../models/VenueRoomAllotment");
const { wholeVenueSpaceIds, isWholeVenueSpace } = require("../utils/venueWholeVenue");
const { windowDays, applyWindowChange } = require("../utils/venueEventWindow");
const { resolveScopedBooking } = require("../utils/venueBookingScope");
const { PAYMENT_MODES, normaliseMode, modeLabel } = require("../utils/venuePaymentMode");
const { mergeClientIntoContacts } = require("../utils/venueClientContact");
const { reserveRoomNights, rederiveRoomNights, releaseRoomNights } = require("../utils/venueRoomNights");
const { derivePhase, describeCancellation } = require("../utils/venueBookingPhase");
const VenueTeamMember = require("../models/VenueTeamMember");
const { cleanStr } = require("../utils/venueInput");

/** Who is doing this. Name as well as id: the id stops resolving when they leave. */
async function bookingActorName(req) {
  if (req.admin) return "Wedsy admin";
  const o = req.venueOwner || {};
  if (o.memberId) {
    const m = await VenueTeamMember.findById(o.memberId).select("name").lean();
    return (m && m.name) || "team member";
  }
  return o.name || "Owner";
}
const { sanitizeContacts } = require("../utils/venueContacts");
const { seedRunsheetForBooking } = require("../utils/venueRunsheet");
const { resolveScopedEnquiry } = require("../utils/venueLeadScope");
const { optStr, optNumber, optDate, optCount, MAXLEN, eventWindow } = require("../utils/venueInput");
const { quoteRoomsForBooking, resolvePolicy } = require("../utils/venueRoomsPolicy");

/** Money in a refusal message, in the same shape the owner reads on screen. */
const inr = (n) => `Rs. ${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;
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
    // Scoped like the rest of the family. This is what the retired booking
    // page's redirector reads to find the lead, so an out-of-scope booking must
    // 404 here rather than hand back a couple's name on the way past.
    const owned = await resolveScopedBooking(req, res);
    if (!owned) return;
    const venue = owned.venue;
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
    // Scoped, not merely venue-owned: this is what the lead's booking-status
    // control calls, and a member who cannot see the lead must not be able to
    // flip its booking to cancelled by knowing an id.
    const owned = await resolveScopedBooking(req, res);
    if (!owned) return;
    const venue = owned.venue;
    const booking = await VenueBooking.findOne({ _id: req.params.bookingId, venue: venue._id });
    if (!booking) return res.status(404).json({ message: "Booking not found" });
    const wasCancelled = booking.status === "cancelled";

    // ── LINE BOOKINGS: the same three rules as confirm, or the generic PATCH
    // is the trivial bypass of all of them. Non-line bookings take this path
    // exactly as they always have.
    if ((booking.lineItems || []).length > 0) {
      const { computeLineTotals } = require("../utils/venueMoney");
      const lf = computeLineTotals(booking.lineItems, booking.gstPercent);
      if (req.body.totalValue !== undefined && Math.round(Number(req.body.totalValue)) !== lf.charged) {
        return res.status(400).json({
          message: `This booking's value comes from its quote lines: ${inr(lf.charged)} charged. Edit the lines to change it.`,
          code: "total_is_derived_from_lines",
          chargedFromLines: lf.charged,
          refundableHeld: lf.refundable,
          statedTotal: Number(req.body.totalValue),
        });
      }
      if (req.body.gstMode !== undefined && req.body.gstMode !== "" && req.body.gstMode !== "none") {
        return res.status(400).json({
          message: "This booking's GST comes from its quote lines — a booking-level GST mode does not apply.",
          code: "line_booking_gst",
        });
      }
      if (req.body.paymentSchedule !== undefined) {
        // Additional billing is the sanctioned money ABOVE the agreed value
        // and is excluded from the equality; everything else — the advance row
        // included, since a stored schedule carries it as a paid row — must
        // total what the lines say is collected.
        const rows = Array.isArray(req.body.paymentSchedule) ? req.body.paymentSchedule : [];
        const scheduled = rows.filter((r) => !(r && r.isAdditional)).reduce((s, r) => s + (Math.round(Number(r && r.amount)) || 0), 0);
        const payable = lf.charged + lf.refundable;
        if (scheduled !== payable) {
          return res.status(400).json({
            message:
              `The schedule comes to ${inr(scheduled)}, but this booking collects ${inr(payable)}` +
              (lf.refundable > 0 ? ` (${inr(lf.charged)} charged plus ${inr(lf.refundable)} refundable held).` : `.`),
            code: "schedule_value_mismatch",
            bookingValue: lf.charged,
            refundableHeld: lf.refundable,
            payable,
            scheduledAmount: scheduled,
          });
        }
      }
    }

    for (const k of UPDATABLE) {
      if (req.body[k] !== undefined) booking[k] = req.body[k];
    }
    await booking.save();

    // ── CANCELLING GIVES THE ROOMS BACK ────────────────────────────────────
    // It did not, before this. `status` has always been settable straight
    // through UPDATABLE, and nothing downstream listened: a cancelled booking
    // kept every allotted night forever, with no screen showing them and no
    // action that would release them. The rooms were simply gone from the
    // venue's inventory until somebody found the allotments and cancelled each
    // one by hand.
    //
    // Reserving a COUNT at confirmation makes that strictly worse — held rows
    // have no allotment to find — so the cascade is part of this build rather
    // than a follow-up.
    let roomsReleased = 0;
    if (!wasCancelled && booking.status === "cancelled") {
      const released = await releaseRoomNights(booking._id);
      roomsReleased = released.released;
      // The allotment records stay, marked cancelled: the stay is off, but the
      // fact that it was arranged is history and this model does not rewrite
      // history. Only the inventory claim is given up.
      const marked = await VenueRoomAllotment.updateMany(
        { booking: booking._id, status: { $in: ["allotted", "checked_in"] } },
        { $set: { status: "cancelled" } }
      );
      // Recorded even on this path, so a cancellation that arrives through the
      // generic PATCH is as auditable as one through /cancel. The reason may be
      // empty here; the dedicated endpoint is the one that insists on it.
      await VenueBooking.updateOne(
        { _id: booking._id },
        {
          $set: {
            "cancellation.at": new Date(),
            "cancellation.reason": cleanStr((req.body && req.body.cancellationReason) || ""),
            "cancellation.byName": await bookingActorName(req),
            "cancellation.roomNightsReleased": roomsReleased,
            "cancellation.allotmentsCancelled": marked.modifiedCount || 0,
          },
        }
      );
    }
    // Newly added days get the default runsheet skeleton (no-op for existing).
    if (req.body.days !== undefined) await seedRunsheetForBooking(booking);
    return res.status(200).json({ booking, roomsReleased });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// ── GET /venues/:slug/bookings/:bookingId/cancellation-preview ──────────────
// WHAT CANCELLING WOULD RELEASE, named before it happens.
//
// The same describeCancellation() the cancel below calls, so the dates and the
// room count in the confirmation are counted by the query the cascade is about
// to run — not by a second estimate that could disagree. A confirmation that
// promises "3 nights" and then releases 5 is worse than none.
const previewCancellation = async (req, res) => {
  try {
    const owned = await resolveScopedBooking(req, res);
    if (!owned) return;
    const booking = await VenueBooking.findOne({ _id: req.params.bookingId, venue: owned.venue._id });
    if (!booking) return res.status(404).json({ message: "Booking not found" });
    if (booking.status === "cancelled") {
      return res.status(409).json({
        message: "This booking is already cancelled.",
        code: "already_cancelled",
        cancellation: booking.cancellation || null,
      });
    }
    return res.status(200).json({
      phase: derivePhase(booking),
      releases: await describeCancellation(booking),
    });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// ── POST /venues/:slug/bookings/:bookingId/cancel ───────────────────────────
// Cancelling is DESTRUCTIVE — it gives back every room night and calendar block
// this booking holds — so it is its own act with its own endpoint, rather than
// a value passed to a generic update beside `coupleName`.
//
// A REASON IS REQUIRED. It is the only record of a decision whose effects are
// otherwise invisible: six months on, the rooms are simply free and nothing
// says why. The refusal names what is missing rather than failing silently.
const cancelBooking = async (req, res) => {
  try {
    const owned = await resolveScopedBooking(req, res);
    if (!owned) return;
    const booking = await VenueBooking.findOne({ _id: req.params.bookingId, venue: owned.venue._id });
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    if (booking.status === "cancelled") {
      // Not an error worth a 500, and not silently "fine" either: an owner who
      // pressed twice should be told the first one worked.
      return res.status(409).json({
        message: "This booking was already cancelled.",
        code: "already_cancelled",
        cancellation: booking.cancellation || null,
      });
    }

    const reason = cleanStr(req.body && req.body.reason);
    if (!reason) {
      return res.status(400).json({
        message: "Say why this booking is being cancelled — it is the only record of the decision.",
        code: "reason_required",
      });
    }

    // Counted BEFORE the cascade, with the same call the preview used, so what
    // is reported afterwards is what was actually given back.
    const releases = await describeCancellation(booking);

    booking.status = "cancelled";
    const released = await releaseRoomNights(booking._id);
    const marked = await VenueRoomAllotment.updateMany(
      { booking: booking._id, status: { $in: ["allotted", "checked_in"] } },
      { $set: { status: "cancelled" } }
    );
    booking.cancellation = {
      reason: reason.slice(0, 2000),
      at: new Date(),
      byName: await bookingActorName(req),
      roomNightsReleased: released.released || 0,
      allotmentsCancelled: marked.modifiedCount || 0,
    };
    await booking.save();

    return res.status(200).json({
      success: true,
      booking,
      released: {
        roomNights: released.released || 0,
        allotments: marked.modifiedCount || 0,
        dates: releases.dates,
        rooms: releases.rooms,
      },
    });
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
    const venue = await resolveOwnedVenue(req, res, "_id name slug spaces rooms settings blockedDates");
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
// A venue with more bookable spaces than this on one row is not a wedding
// venue picker problem; the cap exists so a malformed payload cannot fan out
// into an unbounded calendar write.
const MAX_CONFIRM_SPACES = 50;
const MAX_SCHEDULE_ROWS = 12;

function parseConfirmDay(s) {
  if (typeof s !== "string" || !ISO_DAY_RE.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return null;
  return d;
}

/**
 * GET /:slug/enquiries/:enquiryId/rooms-quote?ratePerNight=&includedRooms=
 *
 * What the rooms would cost on this lead, so the wizard can show the working
 * and put the number into the booking value the schedule is spread over.
 *
 * PREVIEW AND CONFIRM ARE ONE COMPUTATION. Both go through
 * quoteRoomsForBooking with the same venue select and the same window, so a
 * preview that promises Rs. 96,000 cannot be followed by a confirm that stores
 * something else. Same rule as the payments preview/apply pair.
 */
const previewRoomsQuote = async (req, res) => {
  try {
    // Same select as the confirm path — deliberately, and it is why this is
    // written out rather than defaulted.
    const venue = await resolveOwnedVenue(req, res, "_id name slug rooms roomsPolicy roomTypes");
    if (!venue) return;
    const enquiry = await resolveScopedEnquiry(req.venueOwner, req.venueMember, venue._id, req.params.enquiryId);
    if (!enquiry) return res.status(404).json({ message: "Enquiry not found" });

    const q = req.query || {};
    const rateV = optNumber(q.ratePerNight, "ratePerNight");
    if (!rateV.ok) return res.status(400).json({ message: rateV.message });
    const inclV = optNumber(q.includedRooms, "includedRooms");
    if (!inclV.ok) return res.status(400).json({ message: inclV.message });

    // The window is the LEAD'S, which is what confirming will copy onto the
    // booking. Re-deriving it from anywhere else would be a second opinion
    // about the same fact — ONE DATE settled that.
    const roomsNeeded = (enquiry.requirements && enquiry.requirements.roomsNeeded) || 0;
    const quote = quoteRoomsForBooking({
      venue,
      roomsNeeded,
      checkIn: enquiry.checkIn,
      checkOut: enquiry.checkOut,
      override: { ratePerNight: rateV.value, includedRooms: inclV.value },
    });

    res.status(200).json({
      quote,
      roomsNeeded,
      // Stated so the wizard can say WHY there is nothing to charge, rather
      // than showing a bare zero the owner has to account for.
      window: { checkIn: enquiry.checkIn || null, checkOut: enquiry.checkOut || null },
      hasWindow: Boolean(enquiry.checkIn && enquiry.checkOut),
      policyConfigured: resolvePolicy(venue).configured,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

const confirmBookingFromLead = async (req, res) => {
  // Reported back so the portal can say "added to People" rather than leaving
  // the owner to go and check whether their new contact actually landed.
  let clientSync = null;
  let clientWarnings = [];
  /**
   * ── EVERY EXIT PAST THE CALENDAR WRITE UNDOES IT ────────────────────────
   * Declared out here, and deliberately: once this request has marked
   * date-spaces booked, ANY exit that is not a success has to put them back.
   * A booking refused on its money — or on a typo'd email, or by an unexpected
   * throw — that keeps its dates is unrecoverable: the lead can never be
   * confirmed again, because it now collides with itself.
   *
   * A no-op until the calendar is actually touched, so calling it early is
   * always safe. Reassigned below, once batchRef and convertedRowIds exist.
   */
  let rollbackCalendar = async () => {};
  /**
   * The FULL undo — room nights, calendar, draft — in that order.
   *
   * The deliberate refusals were each doing these three by hand, which is how
   * the catch-all came to do only one of them: there was no single answer to
   * "what does undoing this request mean", so a new exit copied whichever
   * neighbour it happened to sit next to. Now there is one.
   */
  let undoEverything = async () => {};
  try {
    // `roomsPolicy` and `roomTypes` are in here because the rooms line is quoted
    // below and BOTH feed the rate. Omitting either does not fail loudly: the
    // venue reads as unconfigured with no type rate, so quoteRooms returns
    // rateSource "none" and charges nothing — a booking silently confirmed
    // with free rooms. Third time this select has bitten this build.
    const venue = await resolveOwnedVenue(req, res, "_id name slug spaces rooms settings blockedDates roomsPolicy roomTypes");
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
    const wantsAnyNamedSpace = fns.some(
      (f) => f && ((f.space !== undefined && f.space !== null && f.space !== "") || (Array.isArray(f.spaces) && f.spaces.length > 0))
    );
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
      /**
       * ── A ROW MAY NOW NAME SEVERAL SPACES ────────────────────────────────
       * `spaces: [id, ...]` is what the confirm wizard sends since BOOKING 1.
       * Step 1 used to list the lead's FUNCTIONS and take each one's own space,
       * which meant the picker answered "what are you blocking?" with the
       * couple's itinerary — three functions in one hall offered three rows for
       * one space. It now offers the venue's actual spaces, so a row carries
       * the DATE and the names/pax of that day's functions (which is what
       * booking.days is built from) while the SPACE SET is the owner's tick.
       *
       * `space` (singular) stays for anything already sending it. An explicit
       * EMPTY array is refused rather than falling through to whole-property:
       * "the owner ticked nothing" and "the owner chose the whole venue" are
       * different answers, and only one of them should claim every space on the
       * calendar. That distinction is the whole reason this branch is written
       * out rather than defaulted.
       */
      const many = f.spaces;
      if (many !== undefined && many !== null) {
        if (!Array.isArray(many)) return res.status(400).json({ message: `functions[${i}].spaces must be a list` });
        if (many.length === 0) {
          return res.status(400).json({ message: `functions[${i}].spaces is empty — pick at least one space, or leave it out for the entire property` });
        }
        if (many.length > MAX_CONFIRM_SPACES) {
          return res.status(400).json({ message: `functions[${i}].spaces is too long (max ${MAX_CONFIRM_SPACES})` });
        }
        const picked = [];
        const seen = new Set();
        for (const raw of many) {
          const key = String(raw);
          if (seen.has(key)) continue;
          seen.add(key);
          const match = spaceById.get(key);
          if (!match) return res.status(400).json({ message: `functions[${i}].spaces contains a space that is not of this venue` });
          if (match.isBookable === false) return res.status(400).json({ message: `functions[${i}].spaces contains a space that is not bookable` });
          picked.push(match);
        }
        spaces = picked;
      } else if (f.space !== undefined && f.space !== null && f.space !== "") {
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

    // ── A LINE BOOKING KNOWS ITS OWN VALUE (money lines S3) ─────────────────
    // A draft made from a LINE quote carries the quote's lines, and its value
    // is DERIVED from them — charged (revenue) plus the refundable held. The
    // peek happens here, with the money validators and BEFORE any guard reads
    // it (the totalV lesson above, learned once, applied twice).
    //
    // `hasLines` false — every wizard-built and pre-existing booking — leaves
    // EVERY branch below byte-identical to today, gates and all.
    const { computeLineTotals } = require("../utils/venueMoney");
    const draftForLines = await VenueBooking.findOne({ venue: venue._id, enquiry: enquiry._id })
      .select("lineItems gstPercent")
      .lean();
    const bookingLines = (draftForLines && draftForLines.lineItems) || [];
    const hasLines = bookingLines.length > 0;
    const lineFigures = hasLines ? computeLineTotals(bookingLines, draftForLines.gstPercent) : null;
    const payableFromLines = hasLines ? lineFigures.charged + lineFigures.refundable : 0;

    // RULING C: a caller-stated totalValue that DISAGREES with the lines is
    // refused, with both numbers — being told beats being overridden, in
    // either direction. Stating the derived figure back (the wizard echoes the
    // draft's own value) is a no-op, not an error: there is nothing to tell.
    if (hasLines && totalV.value !== undefined && totalV.value !== lineFigures.charged) {
      return res.status(400).json({
        message:
          `This booking's value comes from its quote lines: ${inr(lineFigures.charged)} charged` +
          (lineFigures.refundable > 0 ? ` plus ${inr(lineFigures.refundable)} refundable held` : "") +
          `. Edit the lines to change it — a typed total here would silently disagree with the quote.`,
        code: "total_is_derived_from_lines",
        chargedFromLines: lineFigures.charged,
        refundableHeld: lineFigures.refundable,
        statedTotal: totalV.value,
      });
    }
    // RULING A, enforced at the door: a line booking's GST belongs to its
    // lines. gstMode stays "none" (the seam forced it) and a caller asking for
    // row-level GST is refused rather than quietly creating the double-tax
    // state the enum exists to make unrepresentable. Refused HERE, before the
    // calendar is touched, so no rollback is ever owed for it.
    if (hasLines && body.gstMode !== undefined && body.gstMode !== "" && body.gstMode !== "none") {
      return res.status(400).json({
        message: "This booking's GST comes from its quote lines — a booking-level GST mode does not apply.",
        code: "line_booking_gst",
      });
    }
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
      // S4: a HALF-PERCENTAGE schedule is now the normal shape, not an error.
      // "Rs. 1,00,000 on booking, then 50/50 on the rest" mixes a fixed row with
      // percentage rows, and the rule that replaces the old all-or-none check is
      // checkMixedTotal: fixed comes off the top, percentages split what remains.
      const { checkMixedTotal, ScheduleError } = require("../utils/venuePaymentSchedule");
      // A LINE booking's percentages split what its lines say must be
      // collected — charged plus the refundable held — minus the advance.
      // Every other booking keeps the exact expression that shipped.
      const balanceForRows = hasLines
        ? payableFromLines - (tokenV.value || 0)
        : totalV.value !== undefined ? totalV.value - (tokenV.value || 0) : schedule.reduce((sum, r) => sum + (r.amount || 0), 0);
      let mixed;
      try {
        mixed = checkMixedTotal(
          schedule.map((r) => (r.percent === null || r.percent === undefined ? { amount: r.amount } : { percent: r.percent })),
          balanceForRows
        );
      } catch (e) {
        if (e instanceof ScheduleError) return res.status(400).json({ message: e.message, code: e.code });
        throw e;
      }
      if (!mixed.ok) {
        return res.status(400).json({
          // The message already names the numbers — which is the point of it
          // living in the shared module rather than being composed here.
          message: mixed.message,
          code: mixed.code === "percent_mismatch" ? "schedule_not_100" : mixed.code,
          totalPercent: mixed.totalPercent,
          deltaPercent: mixed.deltaPercent,
          fixedTotal: mixed.fixedTotal,
          percentBase: mixed.percentBase,
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
      // (!hasLines: a line booking gets the UNCONDITIONAL guard below instead,
      // against its own payable — running both would report the same schedule
      // twice against two different bases.)
      if (!hasLines && totalV.value !== undefined) {
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

    // ── THE LINE GUARD: UNCONDITIONAL, both gates gone ──────────────────────
    // The old guard had two gates — a percentage row present, a stated
    // totalValue — because the server otherwise had nothing to check against,
    // and it once shipped having never executed behind them. A line booking's
    // truth is its own lines, so for it the guard runs on EVERY schedule
    // write, amounts-only included: advance + instalments must equal what the
    // lines say is collected — charged PLUS the refundable held. A schedule
    // built over charged alone is the deposit silently never collected; the
    // message says which row to add.
    //
    // A money-less confirm (no token, no rows) writes no schedule and owes
    // this guard nothing.
    if (hasLines && ((tokenV.value || 0) > 0 || schedule.length > 0)) {
      const tokenNow = tokenV.value || 0;
      const scheduled = schedule.reduce((sum, r) => sum + (r.amount || 0), 0);
      if (tokenNow + scheduled !== payableFromLines) {
        return res.status(400).json({
          message:
            `The advance and the instalments come to ${inr(tokenNow + scheduled)}, but this booking collects ${inr(payableFromLines)}` +
            ` — ${inr(lineFigures.charged)} charged` +
            (lineFigures.refundable > 0
              ? ` plus ${inr(lineFigures.refundable)} refundable held. The schedule must collect the deposit too — add it as a row.`
              : `.`),
          code: "schedule_value_mismatch",
          bookingValue: lineFigures.charged,
          refundableHeld: lineFigures.refundable,
          payable: payableFromLines,
          advanceAmount: tokenNow,
          balance: payableFromLines - tokenNow,
          scheduledAmount: scheduled,
        });
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
    // Whether a booking existed BEFORE this request. It decides whether a
    // refusal below may discard the draft: re-confirming an existing booking
    // must never delete it, but a draft this request created and then refused
    // must not survive.
    const draftPreExisted = Boolean(await VenueBooking.exists({ enquiry: enquiry._id }));
    const booking = await createDraftBookingForEnquiry(venue._id, enquiry, req.venueOwner.venueOwnerId);

    /**
     * Undo the draft when a refusal means the booking should not exist.
     *
     * FIXES A PRE-EXISTING LEAK, not only the rooms path. A space-collision 409
     * already left a booking behind with status "confirmed" and no calendar
     * rows — a booking that claimed nothing, which the lead then showed as
     * booked. Proven against main before this build touched it. Every refusal
     * after the draft is created now goes through here, so "nothing was
     * changed" is true of all of them rather than of some.
     */
    const discardDraftIfNew = async () => {
      if (draftPreExisted) return;
      await VenueBooking.deleteOne({ _id: booking._id });
    };

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
          await discardDraftIfNew();
          return res.status(409).json({ message: "One or more date-spaces are already held, booked, or blocked" });
        }
        throw e;
      }
    }

    /**
     * Undo everything this request did to the calendar. Identical to the
     * rollback in the insert path above — kept as one function so a rooms
     * refusal cannot restore less than a space collision does, which is how a
     * booking ends up half-applied.
     *
     * ── ASSIGNED HERE, THE MOMENT THE WRITE IS COMPLETE ───────────────────
     * It used to live two hundred lines further down, beside its first caller.
     * That is a trap: the `let` above leaves it a NO-OP until this line runs,
     * so a rollback added anywhere between the write and the old definition
     * compiled, read correctly, and did nothing. Two of them did exactly that,
     * caught only because the test re-confirmed the same lead and got 409.
     *
     * Its home is the write it undoes, not the refusal that first needed it.
     */
    rollbackCalendar = async () => {
      await VenueSpaceDate.deleteMany({ batchRef });
      if (convertedRowIds.length) {
        await VenueSpaceDate.updateMany(
          { _id: { $in: convertedRowIds } },
          { $set: { state: "held" }, $unset: { bookingRef: 1 } }
        );
      }
    };
    undoEverything = async () => {
      await releaseRoomNights(booking._id);
      await rollbackCalendar();
      await discardDraftIfNew();
    };

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
    // ── THE ROOMS LINE ─────────────────────────────────────────────────────
    // Quoted HERE: after the window exists (nights come from it) and before
    // totalValue is written below, so the rooms money is part of the value the
    // schedule is spread over rather than a figure sitting beside it.
    //
    // OPT-IN. Without body.roomsCharge nothing is quoted and nothing is
    // stored, which is exactly how every caller before this behaved.
    //
    // The wizard previewed this through the SAME function with the SAME
    // inputs (see previewRoomsQuote), so the number it spread across the
    // schedule and the number stored here agree by construction — not by two
    // sides being kept in step by hand.
    let roomsQuote = null;
    const rcBody = body.roomsCharge && typeof body.roomsCharge === "object" ? body.roomsCharge : null;
    if (rcBody && rcBody.include === true) {
      const rateV = optNumber(rcBody.ratePerNight, "roomsCharge.ratePerNight");
      if (!rateV.ok) { await undoEverything(); return res.status(400).json({ message: rateV.message }); }
      const inclV = optNumber(rcBody.includedRooms, "roomsCharge.includedRooms");
      if (!inclV.ok) { await undoEverything(); return res.status(400).json({ message: inclV.message }); }
      roomsQuote = quoteRoomsForBooking({
        venue,
        roomsNeeded: (enquiry.requirements && enquiry.requirements.roomsNeeded) || 0,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        override: { ratePerNight: rateV.value, includedRooms: inclV.value },
      });
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
        // Written as an ENTRY, not a scalar: the token is the booking's first
        // payment and belongs in the same list every later payment lands in. A
        // row created with a scalar here would be a brand-new legacy row — the
        // migration would have to convert something written after it ran.
        entries: [
          {
            amount: token,
            date: new Date(),
            method: tokenMode,
            methodOther: tokenMode === "other" ? modeOtherV.value || "" : "",
            reference: refV.value || "",
            note: noteV.value || "",
            status: "approved",
            recordedBy: req.venueOwner ? req.venueOwner.memberId || req.venueOwner.venueOwnerId : null,
            approvedAt: new Date(),
          },
        ],
        recordedBy: req.venueOwner ? req.venueOwner.memberId || req.venueOwner.venueOwnerId : null,
      });
    }
    rows.push(...schedule);
    if (rows.length) booking.paymentSchedule = rows;
    // GST lives on the BOOKING, not on the venue: two bookings at the same venue
    // can legitimately differ (a corporate client who needs a tax invoice, a
    // family function that does not), and reading it off venue settings would
    // silently re-tax an old booking the day the setting changed.
    if (hasLines) {
      // RULING A: the lines own the GST. gstMode stays "none" and the quote's
      // rate stays as the seam wrote it — a wizard echoing gstMode "none" /
      // gstPercent 0 must not wipe the rate the line treatments apply. A
      // non-none mode was already refused at the door.
      booking.gstMode = "none";
    } else {
      const { normaliseGst } = require("../utils/venuePaymentSchedule");
      const g = normaliseGst({ gstMode: req.body.gstMode, gstPercent: req.body.gstPercent });
      booking.gstMode = g.gstMode;
      booking.gstPercent = g.gstPercent;
    }
    const computedTotal = token + schedule.reduce((s, r) => s + (r.amount || 0), 0);
    // INVARIANT #7, line edition: a line booking's totalValue is derived from
    // its LINES, never from the schedule — token + rows includes the
    // refundable held, and deriving the value from it would write the deposit
    // into revenue. Re-asserted here so a drifted draft cannot survive confirm.
    if (hasLines) booking.totalValue = lineFigures.charged;
    else if (totalV.value !== undefined) booking.totalValue = totalV.value;
    else if (computedTotal > 0) booking.totalValue = computedTotal;

    if (roomsQuote) {
      // TWO NUMBERS THAT CANNOT DISAGREE. The rooms amount is a COMPONENT of
      // totalValue, so a total smaller than the rooms line alone is not a
      // rounding quibble — it means the schedule was built over a value that
      // does not contain the rooms, and the booking would collect less than
      // the document says it charged. Refused, naming both numbers.
      if (roomsQuote.amount > 0 && (booking.totalValue || 0) < roomsQuote.amount) {
        // ROLLED BACK, like every other refusal past this point. Found by a
        // test that retried the SAME lead after a refusal and got 409: the
        // space calendar had already been written, so a booking refused on its
        // money had silently consumed its own dates and could never be
        // confirmed again. The undo was defined below this guard — moving a
        // guard in without moving it up is what made the refusal half-apply.
        await undoEverything();
        return res.status(400).json({
          message:
            `The rooms line is ${inr(roomsQuote.amount)} but the booking value is ` +
            `${inr(booking.totalValue || 0)}. The rooms charge is part of the booking value, ` +
            `so the total has to cover it.`,
          code: "ROOMS_EXCEED_TOTAL",
        });
      }
      booking.roomsCharge = {
        roomsNeeded: roomsQuote.roomsNeeded,
        nights: roomsQuote.nights,
        included: roomsQuote.included,
        chargeable: roomsQuote.chargeable,
        ratePerNight: roomsQuote.ratePerNight,
        rateSource: roomsQuote.rateSource,
        includedSource: roomsQuote.includedSource,
        amount: roomsQuote.amount,
        sentence: roomsQuote.sentence,
        // What was TYPED, kept apart from what was resolved.
        overrideRate: rcBody && rcBody.ratePerNight !== undefined && rcBody.ratePerNight !== "" ? Number(rcBody.ratePerNight) : undefined,
        overrideIncluded: rcBody && rcBody.includedRooms !== undefined && rcBody.includedRooms !== "" ? Number(rcBody.includedRooms) : undefined,
        quotedAt: new Date(),
        quotedBy: req.venueOwner ? req.venueOwner.memberId || req.venueOwner.venueOwnerId : null,
      };
    }
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
        // Rolled back like the rest. A booking refused because somebody typed a
        // bad email must not keep the dates it just claimed.
        if (!cV.ok) { await undoEverything(); return res.status(400).json({ message: `client — ${cV.message}` }); }
        enquiry.contacts = cV.value;
        clientSync = { matchedBy: merged.matchedBy, created: merged.created };
        if (cV.warnings && cV.warnings.length) clientWarnings = cV.warnings;
      }
    }


    // ── ROOMS: RESERVE THE COUNT, NOT A TO-DO ──────────────────────────────
    // The lead's accommodation requirement becomes real inventory here. Before
    // this, roomsNeeded produced a `shortfall` number and nothing else, so a
    // venue could confirm two overlapping weddings each needing 20 of its 25
    // rooms and neither would object — VenueRoomNight had nothing to collide
    // on until somebody allotted named rooms by hand.
    //
    // The window is the booking's own, assigned above from the lead. Not
    // re-derived: ONE DATE made that the single source and re-deriving it here
    // would be a second opinion about the same fact.
    const roomsNeeded = (enquiry.requirements && enquiry.requirements.roomsNeeded) || 0;
    let roomsReservation = null;
    if (roomsNeeded > 0 && booking.checkIn && booking.checkOut) {
      const reservation = await reserveRoomNights({
        venue,
        booking,
        needed: roomsNeeded,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        // REFUSE FIRST, ALLOW ON PURPOSE. Short inventory returns 409 naming
        // the numbers; the owner may then confirm anyway with an explicit
        // acknowledgement. Same shape as the stale-holds path on a window
        // change — the venue is never blocked from selling, only from doing it
        // by accident.
        allowPartial: body.acknowledgeRoomShortfall === true,
      });
      if (!reservation.ok) {
        // Nothing about the booking has been saved yet at this point except the
        // calendar rows and the room nights — undoEverything puts both back.
        if (reservation.code === "rooms_short") {
          await undoEverything();
          const t = reservation.tightest;
          return res.status(409).json({
            message:
              `${t.alreadyHeld} of your ${reservation.total} rooms are already held on ${t.day}, ` +
              `so only ${reservation.available} of the ${reservation.needed} this booking needs are free. ` +
              `Confirm anyway to take the booking and sort the rooms out.`,
            code: "rooms_short",
            needed: reservation.needed,
            available: reservation.available,
            total: reservation.total,
            tightest: t,
            acknowledgeWith: "acknowledgeRoomShortfall",
          });
        }
        await undoEverything();
        return res.status(409).json({
          message: "Those rooms were taken while this booking was being confirmed. Nothing was changed — try again.",
          code: "rooms_conflict",
        });
      }
      roomsReservation = reservation;
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
    // An UNEXPECTED failure past the calendar write leaves the same
    // unrecoverable state a deliberate refusal would: a save that trips a
    // ValidationError consumes the lead's dates and 400s, and the next attempt
    // collides with the rows this request left behind. Best effort — a
    // rollback that itself fails must not replace the real error.
    try { await undoEverything(); } catch (_) { /* keep the original error */ }
    if (err.name === "ValidationError") return res.status(400).json({ message: err.message });
    return res.status(500).json({ message: err.message });
  }
};

module.exports = {
  previewRoomsQuote,
  previewCancellation,
  cancelBooking,
  createDraftBookingForEnquiry,
  listBookings,
  getBooking,
  createBooking,
  updateBooking,
  confirmBookingFromLead,
  updateBookingWindow,
};
