// ROOMS 5 slice 2 — the rooms line reaches the BOOKING VALUE, and does not
// become a sixth money derivation.
//
// The three things this has to prove:
//
//   1. PREVIEW AND CONFIRM ARE ONE COMPUTATION. Not "call the same function" —
//      this build has twice been bitten by two callers that agreed on the
//      function and differed in the arguments they assembled for it.
//   2. THE ROOMS MONEY IS INSIDE totalValue, so summarizeSchedule — still the
//      only derivation — reports it without being taught anything about rooms.
//      A parallel total would show the right number on one screen and the
//      wrong one everywhere money is actually collected.
//   3. NOTHING RE-DERIVES ON READ. The slice-1 invariant fixture is re-run
//      here against the code that can now charge for rooms.
//
// Run: node tests/venue-rooms-money.test.js
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueOwner = require("../models/VenueOwner");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueBooking = require("../models/VenueBooking");
const VenueSpaceDate = require("../models/VenueSpaceDate");
const bookings = require("../controllers/venueBooking");
const { summarizeSchedule } = require("../utils/venuePaymentStatus");

const TAG = `rm-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (a, b, label) => ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };

let venue, owner;
const ROOMS = 25;
const req = (extra = {}) => ({
  params: { slug: venue.slug, ...(extra.params || {}) },
  query: extra.query || {},
  body: extra.body || {},
  venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: owner._id },
  venueMember: null,
});

let phoneSeq = 0;
async function newLead(roomsNeeded, checkIn, checkOut) {
  phoneSeq += 1;
  return VenueEnquiry.create({
    venueId: venue._id, coupleName: `${TAG} couple`,
    couplePhone: String(9000000000 + phoneSeq),
    stage: "negotiating", checkIn: new Date(checkIn), checkOut: new Date(checkOut),
    datesFinalised: true, requirements: { roomsNeeded }, functions: [],
  });
}
async function confirm(lead, extraBody = {}) {
  const day = new Date(lead.checkIn).toISOString().slice(0, 10);
  return call(bookings.confirmBookingFromLead, req({
    params: { enquiryId: String(lead._id) },
    body: { functions: [{ date: day, name: "Wedding", space: String(venue.spaces[0]._id) }], ...extraBody },
  }));
}
const quoteFor = (lead, query = {}) =>
  call(bookings.previewRoomsQuote, req({ params: { enquiryId: String(lead._id) }, query }));

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    venue = await Venue.create({
      name: `${TAG}-v`, slug: `${TAG}-v`,
      spaces: [{ name: "Lawn", isBookable: true }],
      rooms: Array.from({ length: ROOMS }, (_, i) => ({ name: `Room ${i + 1}`, isActive: true })),
      roomTypes: [{ name: "Suite", defaultRate: 7500 }, { name: "Deluxe", defaultRate: 4500 }],
      roomsPolicy: { configured: true, includedWithVenue: "count", includedCount: 8, extraRoomRate: 4000 },
    });
    owner = await VenueOwner.create({ venueId: venue._id, name: "Owner", phone: `${TAG}o`.slice(0, 14), isActive: true });

    // ── [A] preview and confirm are ONE computation ────────────────────────
    console.log("\n[A. the wizard's number and the stored number cannot differ]");
    const lead = await newLead(20, "2035-09-30T10:00:00Z", "2035-10-02T10:00:00Z");
    const pv = await quoteFor(lead);
    eq(pv.code, 200, "the wizard can preview the rooms line");
    eq(pv.body.quote.amount, 12 * 4000 * 2, "…20 rooms, 8 included, 12 × Rs.4,000 × 2 nights");
    eq(pv.body.quote.rateSource, "policy", "…priced off the venue's policy rate");
    ok(/12 × Rs. 4,000 × 2 nights/.test(pv.body.quote.sentence), `…with its working: "${pv.body.quote.sentence}"`);

    const roomsAmount = pv.body.quote.amount;
    const VENUE_SHARE = 500000;
    const TOTAL = VENUE_SHARE + roomsAmount; // what the wizard puts in the box
    const r = await confirm(lead, {
      totalValue: TOTAL,
      paymentSchedule: [{ label: "Instalment 1", amount: TOTAL / 2 }, { label: "Instalment 2", amount: TOTAL / 2 }],
      roomsCharge: { include: true },
    });
    eq(r.code, 200, `confirm succeeds (${r.body && r.body.message})`);
    const b = await VenueBooking.findOne({ enquiry: lead._id }).lean();
    eq(b.roomsCharge.amount, roomsAmount, "🔴 the STORED rooms line is the number the preview promised");
    eq(b.roomsCharge.sentence, pv.body.quote.sentence, "…and the same sentence, word for word");
    eq(b.roomsCharge.rateSource, "policy", "…with the rate's source recorded, not just the rate");

    // ── [B] it is INSIDE the booking value, not beside it ──────────────────
    console.log("\n[B. the rooms money reaches the value the schedule is built from]");
    const s = summarizeSchedule(b);
    eq(s.totals.bookingValue, TOTAL, "🔴 the booking value CONTAINS the rooms charge");
    eq(s.totals.total, TOTAL, "…and so does what the couple owes");
    ok(s.totals.scheduleMatchesValue, "🔴 the payment schedule adds up to it — the rooms money is genuinely being collected");
    eq(s.totals.scheduled, TOTAL, `…across the instalments (${s.totals.scheduled})`);
    // The venue's own share is DERIVED, never stored — a stored copy would go
    // stale the first time somebody edited the total.
    eq(b.venueValue, undefined, "the venue's share is NOT stored as a second number that could drift");
    eq(s.totals.bookingValue - b.roomsCharge.amount, VENUE_SHARE, "…it is derived, and it comes out right");

    // ── [C] the per-booking override ───────────────────────────────────────
    console.log("\n[C. this deal's own numbers beat the policy, and say so]");
    const lead2 = await newLead(20, "2035-11-10T10:00:00Z", "2035-11-12T10:00:00Z");
    const pv2 = await quoteFor(lead2, { ratePerNight: "3500", includedRooms: "10" });
    eq(pv2.body.quote.amount, 10 * 3500 * 2, "override: 10 included, 10 × Rs.3,500 × 2 nights");
    eq(pv2.body.quote.rateSource, "booking", "…and the rate's source is this booking");
    const T2 = 300000 + pv2.body.quote.amount;
    const r2 = await confirm(lead2, {
      totalValue: T2, paymentSchedule: [{ label: "Full", amount: T2 }],
      roomsCharge: { include: true, ratePerNight: 3500, includedRooms: 10 },
    });
    eq(r2.code, 200, `confirm with an override succeeds (${r2.body && r2.body.message})`);
    const b2 = await VenueBooking.findOne({ enquiry: lead2._id }).lean();
    eq(b2.roomsCharge.amount, 70000, "the stored line uses the override");
    eq(b2.roomsCharge.overrideRate, 3500, "🔴 what the owner TYPED is kept separately from what was resolved");
    eq(b2.roomsCharge.overrideIncluded, 10, "…both of them");
    eq(summarizeSchedule(b2).totals.bookingValue, T2, "…and the overridden amount is inside the booking value");

    // ── [D] two numbers that cannot disagree ──────────────────────────────
    console.log("\n[D. a total that cannot contain the rooms line is refused]");
    const lead3 = await newLead(20, "2035-12-10T10:00:00Z", "2035-12-12T10:00:00Z");
    const bad = await confirm(lead3, { totalValue: 5000, paymentSchedule: [{ label: "Full", amount: 5000 }], roomsCharge: { include: true } });
    eq(bad.code, 400, "refused");
    eq(bad.body.code, "ROOMS_EXCEED_TOTAL", "…with a code the wizard can branch on");
    ok(/96,000/.test(bad.body.message) && /5,000/.test(bad.body.message), `…naming BOTH numbers: "${bad.body.message}"`);
    // Stated as "which of the two" rather than a count that would also read 0
    // if no booking existed — a refusal test that passes because nothing
    // happened at all is the vacuous shape.
    const b3 = await VenueBooking.findOne({ enquiry: lead3._id }).lean();
    ok(!b3 || !b3.roomsCharge || !b3.roomsCharge.amount,
      `…and no rooms line was stored (booking ${b3 ? "exists as a draft with no rooms line" : "was not created"})`);
    // And the control: the SAME lead confirms fine once the total covers it.
    const good3 = await confirm(lead3, { totalValue: 200000, paymentSchedule: [{ label: "Full", amount: 200000 }], roomsCharge: { include: true } });
    eq(good3.code, 200, "…while the same lead confirms once the total covers the rooms — the refusal is the amount, not the shape");
    const b3ok = await VenueBooking.findOne({ enquiry: lead3._id }).lean();
    eq(b3ok.roomsCharge.amount, 96000, "…and then the rooms line IS stored");

    // ── [E] opt-in: without it, nothing changes at all ────────────────────
    console.log("\n[E. every caller that existed before this behaves EXACTLY as before]");
    const lead4 = await newLead(20, "2036-01-10T10:00:00Z", "2036-01-12T10:00:00Z");
    const r4 = await confirm(lead4, { totalValue: 400000, paymentSchedule: [{ label: "Full", amount: 400000 }] });
    eq(r4.code, 200, "a confirm with no roomsCharge in the body still succeeds");
    const b4 = await VenueBooking.findOne({ enquiry: lead4._id }).lean();
    eq(b4.roomsCharge, undefined, "🔴 nothing is stored — no rooms line was agreed");
    eq(summarizeSchedule(b4).totals.bookingValue, 400000, "🔴 and the total is exactly what was sent");
    eq(b4.roomsRequired, 20, "…while the ROOM REQUIREMENT is still recorded — rooms are held, just not charged");

    // ── [F] the invariant, against code that can now charge ───────────────
    console.log("\n[F. 🔴 a booking confirmed WITH rooms does not move when the policy changes]");
    const before = summarizeSchedule(await VenueBooking.findById(b._id));
    eq(before.totals.bookingValue, TOTAL, "before: the agreed value");
    const v = await Venue.findById(venue._id);
    v.roomsPolicy = { configured: true, includedWithVenue: "none", includedCount: 0, extraRoomRate: 25000 };
    await v.save();
    const after = summarizeSchedule(await VenueBooking.findById(b._id));
    eq(after.totals.bookingValue, TOTAL, "🔴 the agreed value did NOT move");
    eq(after.totals.total, TOTAL, "🔴 nor did what the couple owes");
    const reread = await VenueBooking.findById(b._id).lean();
    eq(reread.roomsCharge.amount, roomsAmount, "🔴 nor did the stored rooms line");
    eq(reread.roomsCharge.ratePerNight, 4000, "🔴 …still priced at the rate agreed, not today's Rs.25,000");

    // ── [G] there is still exactly ONE money derivation ───────────────────
    console.log("\n[G. summarizeSchedule was not taught about rooms]");
    const src = require("fs").readFileSync(require.resolve("../utils/venuePaymentStatus"), "utf8");
    ok(!/room/i.test(src), "🔴 utils/venuePaymentStatus contains no reference to rooms — it reads totalValue and nothing else");
    // ── [H] no refusal past the calendar write may keep the dates ─────────
    // The rule, swept rather than spot-checked: once this request has marked
    // date-spaces booked, every exit that is not a success has to put them
    // back. A lead that loses its dates to a refusal can never be confirmed
    // again — it collides with itself — and nothing on screen explains why.
    //
    // Each case asserts the REFUSAL and then re-confirms the SAME lead and
    // requires 200. "Nothing was stored" alone would pass on a lead that had
    // been quietly bricked.
    console.log("\n[H. 🔴 every refusal past the calendar write releases the dates]");
    const spaceRows = () => VenueSpaceDate.countDocuments({ venue: venue._id, state: "booked" });

    const cases = [
      ["a bad rooms rate", { roomsCharge: { include: true, ratePerNight: "not-a-number" } }, 400],
      ["a bad included count", { roomsCharge: { include: true, includedRooms: "eight" } }, 400],
      ["a rooms line bigger than the total", { totalValue: 5000, paymentSchedule: [{ label: "Full", amount: 5000 }], roomsCharge: { include: true } }, 400],
      ["a typo'd client email", { client: { name: "Someone", email: "not an email", phone: "9812345678" } }, 400],
    ];
    for (let i = 0; i < cases.length; i++) {
      const [label, badBody, wantCode] = cases[i];
      const yr = 2040 + i;
      const l = await newLead(20, `${yr}-04-10T10:00:00Z`, `${yr}-04-12T10:00:00Z`);
      const rowsBefore = await spaceRows();
      const refused = await confirm(l, { totalValue: 400000, paymentSchedule: [{ label: "Full", amount: 400000 }], ...badBody });
      ok(refused.code >= 400, `${label} → refused (${refused.code})`);
      if (wantCode) ok(refused.code === wantCode, `  …with ${wantCode} (got ${refused.code})`);
      ok(await spaceRows() === rowsBefore, `  …and the calendar is back where it was (${await spaceRows()} booked rows)`);
      // THE POSITIVE CONTROL: the same lead, fixed, must still be confirmable.
      const retry = await confirm(l, { totalValue: 400000, paymentSchedule: [{ label: "Full", amount: 400000 }] });
      ok(retry.code === 200, `  🔴 …and the SAME lead still confirms afterwards (got ${retry.code}: ${retry.body && retry.body.message})`);
    }

    // The catch-all, which no BAD INPUT can reach — every malformed field is
    // refused before the save. So it is faulted deliberately: a save that
    // throws is the realistic version (a schema change, an index conflict, a
    // dropped connection), and until now it would have 500'd with the lead's
    // dates already consumed.
    {
      const l = await newLead(20, "2050-04-10T10:00:00Z", "2050-04-12T10:00:00Z");
      const rowsBefore = await spaceRows();
      const realSave = VenueBooking.prototype.save;
      let thrown = false;
      VenueBooking.prototype.save = function (...a) {
        if (!thrown) { thrown = true; const e = new Error("injected: save failed"); e.name = "ValidationError"; throw e; }
        return realSave.apply(this, a);
      };
      let injected;
      try {
        injected = await confirm(l, { totalValue: 400000, paymentSchedule: [{ label: "Full", amount: 400000 }] });
      } finally {
        VenueBooking.prototype.save = realSave;
      }
      ok(thrown, "an unexpected save failure was actually injected — the case is real, not skipped");
      ok(injected.code >= 400, `an unexpected throw → refused (${injected.code})`);
      ok(await spaceRows() === rowsBefore, `  …and the calendar is back where it was (${await spaceRows()} booked rows)`);
      const retry = await confirm(l, { totalValue: 400000, paymentSchedule: [{ label: "Full", amount: 400000 }] });
      ok(retry.code === 200, `  🔴 …and the SAME lead still confirms afterwards (got ${retry.code}: ${retry.body && retry.body.message})`);
    }

  } catch (err) {
    fail += 1;
    console.error("\nFATAL", err);
  } finally {
    try {
      const leads = await VenueEnquiry.find({ venueId: venue && venue._id }).select("_id").lean();
      await VenueBooking.deleteMany({ venue: venue && venue._id });
      await VenueEnquiry.deleteMany({ _id: { $in: leads.map((l) => l._id) } });
      await require("../models/VenueRoomNight").deleteMany({ venue: venue && venue._id });
      await VenueSpaceDate.deleteMany({ venue: venue && venue._id });
      await VenueOwner.deleteMany({ _id: owner && owner._id });
      await Venue.deleteMany({ _id: venue && venue._id });
    } catch (e) { /* best effort */ }
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  }
})();
