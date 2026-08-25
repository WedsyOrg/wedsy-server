// Booking status: derived where it is a FACT, deliberate where it is a DECISION.
//
// The audit this build rests on: nothing in the server reads `in_progress` or
// `completed` — every consumer tests only `!== "cancelled"`. So the suite pins
// BOTH halves of that finding:
//
//   · derivePhase answers from the dates, including at 02:00 IST on the event
//     day, where a UTC "today" gets it wrong by one day on precisely the day it
//     matters most
//   · the cancel path demands a reason, says what it will release BEFORE it
//     releases it, and reports afterwards what it actually gave back — from
//     the SAME call, so the promise and the outcome cannot disagree
//
// Run: node tests/venue-booking-phase.test.js
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueBooking = require("../models/VenueBooking");
const VenueRoomNight = require("../models/VenueRoomNight");
const VenueRoomAllotment = require("../models/VenueRoomAllotment");

const { derivePhase, describeCancellation } = require("../utils/venueBookingPhase");
const bookings = require("../controllers/venueBooking");
const { reserveRoomNights } = require("../utils/venueRoomNights");

const TAG = `phase-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const created = { venues: [], leads: [], bookings: [] };
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };
const d = (n) => new Date(Date.now() + n * 86400000);

let venue, lead;
const asOwner = (bookingId, extra = {}) => ({
  params: { slug: venue.slug, bookingId: String(bookingId) },
  query: {}, body: extra.body || {},
  venueOwner: { type: "venue_owner", venueId: venue._id, role: "owner" },
});

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    venue = await Venue.create({ name: `${TAG} Palace`, slug: `${TAG}-v`, city: "Bangalore", state: "Karnataka" });
    created.venues.push(venue._id);
    lead = await VenueEnquiry.create({
      venueId: venue._id, coupleName: `${TAG} Couple`, coupleNameManual: true,
      couplePhone: "9800001111", stage: "booked",
    });
    created.leads.push(lead._id);

    // ══ 1. THE PHASE IS A FACT ══════════════════════════════════════════════
    console.log("\n[the phase is read from the dates, not clicked]");
    ok(derivePhase({ days: [{ date: d(35) }] }).label === "Confirmed", "35 days out → Confirmed");
    ok(derivePhase({ days: [{ date: d(35) }] }).derived === true, "…and it says it was derived, not stored");
    ok(derivePhase({ days: [{ date: d(0) }] }).label === "Happening now", "today → Happening now");
    ok(derivePhase({ days: [{ date: d(-1) }, { date: d(1) }] }).label === "Happening now", "a multi-day event mid-run → Happening now");
    ok(derivePhase({ days: [{ date: d(-9) }] }).label === "Completed", "nine days ago → Completed");

    console.log("\n[the cases where guessing would be wrong]");
    ok(derivePhase({ days: [] }).label === "Confirmed", "no dates → Confirmed, not Completed");
    ok(derivePhase({ days: [] }).derived === false, "…and it does NOT claim to have derived that");
    ok(derivePhase({ status: "cancelled", days: [{ date: d(-9) }] }).label === "Cancelled",
      "a cancelled booking stays Cancelled — a decision outranks the calendar");
    ok(derivePhase(null).label === "Confirmed", "no booking at all does not throw");

    console.log("\n[02:00 IST on the event day — where a UTC 'today' is wrong]");
    const eventDay = new Date("2026-09-10T00:00:00.000Z");
    const at2amIST = new Date("2026-09-09T20:30:00.000Z"); // 02:00 IST on the 10th
    ok(derivePhase({ days: [{ date: eventDay }] }, at2amIST).label === "Happening now",
      "…reads Happening now, because the venue's day is what the owner is living in");
    const at1130pmIST = new Date("2026-09-10T18:00:00.000Z"); // 23:30 IST on the 10th
    ok(derivePhase({ days: [{ date: eventDay }] }, at1130pmIST).label === "Happening now",
      "…and still Happening now at 23:30 IST, not yet Completed");

    // ══ 2. CANCELLING ═══════════════════════════════════════════════════════
    console.log("\n[cancelling says what it will release, before it releases it]");
    const booking = await VenueBooking.create({
      venue: venue._id, enquiry: lead._id, coupleName: `${TAG} Couple`, totalValue: 500000,
      days: [{ date: d(30), eventType: "wedding", guestCount: 200 }, { date: d(31), eventType: "reception", guestCount: 200 }],
      paymentSchedule: [{ label: "Advance", amount: 200000, dueDate: d(-2) }],
    });
    created.bookings.push(booking._id);
    // ── BUILT THE WAY THE REAL CALLER BUILDS THEM ─────────────────────────
    // The first draft of this fixture wrote room nights by hand with a `date`
    // field. The model's field is `night`, so the rows were rejected — and the
    // util under test had the SAME mistake, reading n.date and quietly
    // producing an empty date list beside a correct count. Reserving through
    // reserveRoomNights, which is what confirmation actually calls, is what
    // surfaced it.
    const roomVenue = await Venue.findByIdAndUpdate(
      venue._id,
      { $set: { rooms: [{ name: "101", capacity: 2, isActive: true }, { name: "102", capacity: 2, isActive: true }] } },
      { new: true }
    );
    const reserved = await reserveRoomNights({
      venue: roomVenue, booking, needed: 1, checkIn: d(30), checkOut: d(33),
    });
    ok(reserved.ok && reserved.reserved === 1, `fixture: reserved ${reserved.reserved} room across 3 nights through the real path`);
    const roomId = reserved.rooms[0];
    const allot = await VenueRoomAllotment.create({
      venue: venue._id, booking: booking._id, room: roomId, guestName: "Bride's family",
      checkInAt: d(30), checkOutAt: d(33), status: "allotted",
    });

    const prev = await call(bookings.previewCancellation, asOwner(booking._id));
    ok(prev.code === 200, `preview → 200 (got ${prev.code})`);
    ok(prev.body.releases.roomNights === 3, `names ${prev.body.releases.roomNights} room nights`);
    ok(prev.body.releases.rooms === 1, `across ${prev.body.releases.rooms} room`);
    ok(prev.body.releases.dates.length === 3, `and names the dates: ${prev.body.releases.dates.join(", ")}`);
    ok(prev.body.releases.allotments === 1, "and the allotment that would be cancelled");
    ok(prev.body.phase.label === "Confirmed", "…alongside the phase, so the owner sees it is 30 days out");

    console.log("\n[a reason is required, and the refusal says what is missing]");
    const noReason = await call(bookings.cancelBooking, asOwner(booking._id));
    ok(noReason.code === 400 && noReason.body.code === "reason_required", `→ 400 reason_required (got ${noReason.code})`);
    ok(/only record of the decision/.test(noReason.body.message), `…in words: "${noReason.body.message}"`);
    const stillLive = await VenueBooking.findById(booking._id);
    ok(stillLive.status !== "cancelled", "…and NOTHING was cancelled");
    ok(await VenueRoomNight.countDocuments({ booking: booking._id }) === 3, "…and the room nights are all still held");

    console.log("\n[with a reason, it cancels — and reports what it actually gave back]");
    const done = await call(bookings.cancelBooking, asOwner(booking._id, { body: { reason: "Couple postponed to next season" } }));
    ok(done.code === 200, `→ 200 (got ${done.code})`);
    ok(done.body.released.roomNights === 3, `released ${done.body.released.roomNights} room nights`);
    ok(done.body.released.allotments === 1, `cancelled ${done.body.released.allotments} allotment`);
    ok(JSON.stringify(done.body.released.dates) === JSON.stringify(prev.body.releases.dates),
      "…the SAME dates the preview promised — one computation, not two estimates");
    ok(done.body.released.roomNights === prev.body.releases.roomNights,
      "…and the same count, so the confirmation could not have over- or under-promised");

    console.log("\n[and the decision is on the record]");
    const after = await VenueBooking.findById(booking._id);
    ok(after.status === "cancelled", "status is cancelled");
    ok(after.cancellation.reason === "Couple postponed to next season", `reason kept: "${after.cancellation.reason}"`);
    ok(Boolean(after.cancellation.at), "…with when");
    ok(after.cancellation.byName === "Owner", `…and who: ${after.cancellation.byName}`);
    ok(after.cancellation.roomNightsReleased === 3, "…and what it cost, recorded at the moment it ran");

    console.log("\n[the inventory really is back]");
    ok(await VenueRoomNight.countDocuments({ booking: booking._id }) === 0, "no room nights remain");
    const allotAfter = await VenueRoomAllotment.findById(allot._id);
    ok(allotAfter.status === "cancelled", "the allotment is marked cancelled");
    ok(allotAfter !== null, "…and KEPT — the stay is off, but that it was arranged is history");

    console.log("\n[pressing cancel twice is told the first one worked]");
    const again = await call(bookings.cancelBooking, asOwner(booking._id, { body: { reason: "again" } }));
    ok(again.code === 409 && again.body.code === "already_cancelled", `→ 409 already_cancelled (got ${again.code})`);
    ok((await VenueBooking.findById(booking._id)).cancellation.reason === "Couple postponed to next season",
      "…and the original reason was not overwritten by the second attempt");
    const prevAgain = await call(bookings.previewCancellation, asOwner(booking._id));
    ok(prevAgain.code === 409 && prevAgain.body.code === "already_cancelled", "…and the preview says so too, rather than offering to do it again");

    console.log("\n[a booking with nothing allotted says so]");
    // A second lead: one booking per enquiry is a unique index, and reusing the
    // first lead here hit it. The index is right; the fixture was wrong.
    const lead2 = await VenueEnquiry.create({
      venueId: venue._id, coupleName: `${TAG} Bare`, coupleNameManual: true,
      couplePhone: "9800002222", stage: "booked",
    });
    created.leads.push(lead2._id);
    const bare = await VenueBooking.create({
      venue: venue._id, enquiry: lead2._id, coupleName: `${TAG} Bare`, totalValue: 100000,
      days: [{ date: d(60), eventType: "wedding", guestCount: 50 }],
    });
    created.bookings.push(bare._id);
    const barePrev = await call(bookings.previewCancellation, asOwner(bare._id));
    ok(barePrev.body.releases.releasesNothing === true, "releasesNothing is true, so the screen can say 'nothing to release'");
    ok(barePrev.body.releases.roomNights === 0 && barePrev.body.releases.allotments === 0, "…and both counts are zero");

    // ══ 3. THE AUDIT'S CLAIM, PINNED ════════════════════════════════════════
    console.log("\n[cancelled is still the only status any consumer reads]");
    const live = await VenueBooking.countDocuments({ venue: venue._id, status: { $ne: "cancelled" } });
    ok(live === 1, `${live} non-cancelled booking of 2 — the query every consumer actually runs`);
  } catch (err) {
    fail += 1;
    console.error("\nFATAL", err);
  } finally {
    try {
      await VenueRoomNight.deleteMany({ venue: { $in: created.venues } });
      await VenueRoomAllotment.deleteMany({ venue: { $in: created.venues } });
      await VenueBooking.deleteMany({ _id: { $in: created.bookings } });
      await VenueEnquiry.deleteMany({ _id: { $in: created.leads } });
      await Venue.deleteMany({ _id: { $in: created.venues } });
    } catch (e) { /* best effort */ }
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  }
})();
