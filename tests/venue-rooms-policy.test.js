// ROOMS 5 slice 1 — how a venue sells its rooms, and the invariant that
// shipping it moves no existing booking's money.
//
// ── THE PROOF THAT MATTERS ──────────────────────────────────────────────────
// Proving a ROOMLESS booking does not move is necessary and weak: it is the
// case that cannot move by construction. The load-bearing fixture here is a
// booking that predates this feature and HAS rooms — 20 of them — at a venue
// whose policy would charge Rs. 96,000 for exactly that shape. If the rooms
// charge were ever derived at READ time, that booking's total would jump the
// moment its venue saved a policy. It must not.
//
// That assertion is written in this slice and must stay green through the
// slice that actually adds rooms money to the total. It is the regression test
// for the one mistake that would undo this build.
//
// Run: node tests/venue-rooms-policy.test.js
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueBooking = require("../models/VenueBooking");
const rt = require("../controllers/venueRoomTypes");
const { resolvePolicy, quoteRooms, includedRooms, nightsBetween } = require("../utils/venueRoomsPolicy");
const { summarizeSchedule } = require("../utils/venuePaymentStatus");

const TAG = `rmpol${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (a, b, label) => ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const created = { venues: [], leads: [], bookings: [] };
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };
const daysAhead = (n) => new Date(Date.now() + n * 86400000);

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    console.log("\n[an unconfigured venue is inert — which is exactly today's behaviour]");
    const blank = resolvePolicy({});
    eq(blank.configured, false, "configured is false when nobody has answered");
    eq(blank.includedWithVenue, "all", "…and it resolves to all-included, so nothing is chargeable");
    eq(quoteRooms({ policy: blank, roomsNeeded: 20, nights: 3, totalRoomsAtVenue: 25, typeRate: 4500 }).amount, 0,
      "a 20-room 3-night booking at an unconfigured venue costs 0");
    const v = new Venue({ name: "x", slug: `${TAG}probe`, city: "c", state: "s" });
    eq(v.toObject().roomsPolicy, undefined, "and NOTHING is stored — no default writes an answer nobody gave");

    console.log("\n[the three rate levels, each narrower, and each naming its source]");
    const P = (o) => resolvePolicy({ roomsPolicy: { configured: true, ...o } });
    const base = { roomsNeeded: 20, nights: 2, totalRoomsAtVenue: 25 };
    const typeOnly = quoteRooms({ ...base, policy: P({ includedWithVenue: "count", includedCount: 8 }), typeRate: 4500 });
    eq(typeOnly.rateSource, "type", "with no policy rate, the room type's own rate is used");
    eq(typeOnly.amount, 12 * 4500 * 2, "…and it multiplies out");
    const policyWins = quoteRooms({ ...base, policy: P({ includedWithVenue: "count", includedCount: 8, extraRoomRate: 4000 }), typeRate: 4500 });
    eq(policyWins.rateSource, "policy", "a policy rate beats the type rate");
    eq(policyWins.amount, 12 * 4000 * 2, "…and it is the one that multiplies out");
    const bookingWins = quoteRooms({ ...base, policy: P({ includedWithVenue: "count", includedCount: 8, extraRoomRate: 4000 }), typeRate: 4500, override: { ratePerNight: 3500 } });
    eq(bookingWins.rateSource, "booking", "this booking's own rate beats both");
    eq(bookingWins.amount, 12 * 3500 * 2, "…and it is the one that multiplies out");
    ok(/12 × Rs. 3,500 × 2 nights/.test(bookingWins.sentence), `the working is stated: "${bookingWins.sentence}"`);

    console.log("\n[the arithmetic's edges]");
    eq(includedRooms(P({ includedWithVenue: "count", includedCount: 8 }), 5), 5,
      "8 included at a 5-room venue is 5 — never more rooms than exist");
    eq(quoteRooms({ ...base, policy: P({ includedWithVenue: "count", includedCount: 40, extraRoomRate: 4000 }) }).chargeable, 0,
      "more included than needed charges for 0, not for a negative number");
    eq(quoteRooms({ ...base, policy: P({ includedWithVenue: "none", extraRoomRate: 4000 }), nights: 0 }).amount, 0,
      "zero nights is zero money");
    const noRate = quoteRooms({ ...base, policy: P({ includedWithVenue: "none" }) });
    eq(noRate.amount, 0, "extras with no rate anywhere charge nothing");
    ok(/no rate set/.test(noRate.sentence), `…and SAY so rather than showing a silent 0: "${noRate.sentence}"`);
    eq(nightsBetween("2026-09-10", "2026-09-12"), 2, "10th to 12th is 2 nights");
    eq(nightsBetween("2026-09-10", "2026-09-10"), 0, "same day is 0 nights");

    console.log("\n[the endpoints]");
    const venue = await Venue.create({
      name: `${TAG} Resort`, slug: `${TAG}-v`, city: "Bangalore", state: "Karnataka",
      rooms: Array.from({ length: 25 }, (_, i) => ({ name: `R${i + 1}`, isActive: true })),
      roomTypes: [{ name: "Deluxe", defaultRate: 4500 }],
    });
    created.venues.push(venue._id);
    const req = (body) => ({ params: { slug: venue.slug }, query: {}, body: body || {}, venueOwner: { venueId: venue._id, type: "venue_owner" } });

    const first = await call(rt.getRoomsPolicy, req());
    eq(first.code, 200, "GET rooms-policy answers");
    eq(first.body.policy.configured, false, "…reporting the venue has not answered yet");
    eq(first.body.totalRooms, 25, "…and how many rooms it actually has");
    eq(first.body.fallbackTypeRate, 4500, "…and the type rate the fallback would use");

    const saved = await call(rt.updateRoomsPolicy, req({ includedWithVenue: "count", includedCount: 8, extraRoomRate: 4000, sellsNightly: true }));
    eq(saved.code, 200, "PUT rooms-policy saves");
    eq(saved.body.policy.configured, true, "…and saving IS the answer");
    eq(saved.body.includedUnderPolicy, 8, "…8 of 25 included");
    eq(saved.body.example.rateSource, "policy", "…the worked example uses the policy rate");
    eq(saved.body.example.amount, 17 * 4000 * 1, "…and shows what a full-house night costs");

    const bad = await call(rt.updateRoomsPolicy, req({ includedWithVenue: "some" }));
    eq(bad.code, 400, "an unknown includedWithVenue is refused");
    const neg = await call(rt.updateRoomsPolicy, req({ extraRoomRate: -100 }));
    eq(neg.code, 400, "a negative rate is refused");
    const partial = await call(rt.updateRoomsPolicy, req({ extraRoomRate: 5000 }));
    eq(partial.body.policy.includedCount, 8, "a partial save keeps what it did not mention");
    eq(partial.body.policy.extraRoomRate, 5000, "…and applies what it did");

    console.log("\n[🔴 THE INVARIANT — a booking that PREDATES this feature and HAS rooms]");
    const lead = await VenueEnquiry.create({
      venueId: venue._id, coupleName: "Priya & Arjun", coupleNameManual: true,
      couplePhone: "9800002222", stage: "booked", requirements: { roomsNeeded: 20 },
    });
    created.leads.push(lead._id);
    // Confirmed the old way: a total agreed by hand, a schedule spreading it,
    // 20 rooms on the booking, and NO rooms line — because none existed.
    const legacy = await VenueBooking.create({
      venue: venue._id, enquiry: lead._id, coupleName: "Priya & Arjun",
      totalValue: 300000, roomsRequired: 20,
      days: [{ date: daysAhead(30), eventType: "wedding", guestCount: 200 }],
      paymentSchedule: [
        { label: "Token", amount: 100000, dueDate: daysAhead(1) },
        { label: "Instalment 1", amount: 200000, dueDate: daysAhead(20) },
      ],
    });
    created.bookings.push(legacy._id);

    // Pinned to LITERALS, not just to `before`. The first run of this suite
    // asserted after === before and passed while both were undefined — a green
    // invariant that was comparing nothing to nothing.
    const before = summarizeSchedule(await VenueBooking.findById(legacy._id));
    eq(before.totals.bookingValue, 300000, "before: the agreed value is what was agreed");

    // What this booking's shape WOULD be quoted at under the venue's policy —
    // Rs. 5,000 × 12 extra rooms × 1 night. A read-time derivation would add it.
    const wouldCharge = quoteRooms({
      policy: resolvePolicy(await Venue.findById(venue._id).select("roomsPolicy")),
      roomsNeeded: 20, nights: 1, totalRoomsAtVenue: 25, typeRate: 4500,
    });
    ok(wouldCharge.amount > 0, `the policy WOULD charge ${wouldCharge.amount} for this exact shape — so this is a real test, not a vacuous one`);

    const after = summarizeSchedule(await VenueBooking.findById(legacy._id));
    eq(after.totals.bookingValue, 300000, "🔴 the agreed value did NOT move");
    eq(after.totals.total, before.totals.total, "🔴 the total did NOT move");
    eq(after.totals.balance, before.totals.balance, "🔴 the balance did NOT move");
    eq(after.rows.length, 2, "🔴 no row was invented on an existing schedule");
    const stored = await VenueBooking.findById(legacy._id).lean();
    eq(stored.totalValue, 300000, "🔴 and the stored total is untouched on disk");

    console.log("\n[…and it still does not move when the venue EDITS its policy]");
    await call(rt.updateRoomsPolicy, req({ includedWithVenue: "none", extraRoomRate: 9000 }));
    const afterEdit = summarizeSchedule(await VenueBooking.findById(legacy._id));
    eq(afterEdit.totals.bookingValue, 300000, "🔴 a policy edit does not reprice a confirmed booking");
    eq(afterEdit.totals.balance, before.totals.balance, "🔴 …and the couple still owes what they owed");
  } catch (err) {
    fail += 1;
    console.error("\nFATAL", err);
  } finally {
    try {
      await VenueBooking.deleteMany({ _id: { $in: created.bookings } });
      await VenueEnquiry.deleteMany({ _id: { $in: created.leads } });
      await Venue.deleteMany({ _id: { $in: created.venues } });
    } catch (e) { /* best effort */ }
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  }
})();
