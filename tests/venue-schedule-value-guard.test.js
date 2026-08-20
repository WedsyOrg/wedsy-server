// The 100%-rule guard on the WRITE PATH, actually executed.
// Run: node tests/venue-schedule-value-guard.test.js
//
// WHY THIS EXISTS — and why it is a separate file rather than three more
// assertions somewhere.
//
// The guard it covers was built to stop a real over-collection bug: a token
// recorded as paid, plus percentage rows still costed against the FULL booking
// value, billed the couple more than the booking was worth. The guard was
// written, reported as done, and merged.
//
// It had never once been run. `schedule_value_mismatch` appeared in the suite
// only inside a COMMENT. And because the guard reads `totalV` — which was
// declared thirty lines further down the same function — the very first
// request that reached it threw
//
//     ReferenceError: Cannot access 'totalV' before initialization
//
// a 500 on the exact path the guard existed to protect. A human found it on
// the first real run of the confirm wizard.
//
// The reason no existing test caught it is the part worth keeping: the guard
// lives inside `if (withPercent.length)`, so it only runs for PERCENTAGE
// schedules. Every prior test sent amounts-only schedules and sailed past it.
// The wizard sends percentages, because payment shapes are percentages. So the
// tests exercised a path no real caller uses, and no test exercised the path
// every real caller takes.
//
// Hence: every case below sends PERCENT rows.
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueOwner = require("../models/VenueOwner");
const VenueBooking = require("../models/VenueBooking");
const VenueSpaceDate = require("../models/VenueSpaceDate");

const ctrl = require("../controllers/venueBooking");

const TAG = `svg-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });

let venue, owner;
let dayCursor = 1;
const nextDate = () => `2033-0${Math.ceil(dayCursor / 28)}-${String(((dayCursor++ - 1) % 28) + 1).padStart(2, "0")}`;

/** Confirms a fresh lead so each case gets a clean booking + clean dates. */
async function confirmWith(body) {
  const lead = await VenueEnquiry.create({
    venueId: venue._id, coupleName: `${TAG} couple`, couplePhone: `9${Date.now()}`.slice(0, 10),
    stage: "negotiating",
  });
  const res = mockRes();
  await ctrl.confirmBookingFromLead({
    params: { slug: venue.slug, enquiryId: String(lead._id) }, query: {}, body,
    venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: owner._id }, venueMember: null,
  }, res);
  return { res, lead };
}

const fn = (date) => [{ date, name: "Wedding", space: String(venue.spaces[0]._id) }];

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    venue = await Venue.create({ name: `${TAG}-v`, slug: `${TAG}-v`, spaces: [{ name: "Hall", isBookable: true }] });
    owner = await VenueOwner.create({ venueId: venue._id, name: "Owner", phone: `${TAG}o`.slice(0, 14), isActive: true });

    // ── [A] the regression itself ──
    console.log("\n[A. the guard RUNS — it must not throw reaching for its own inputs]");
    const balanced = await confirmWith({
      functions: fn(nextDate()), tokenAmount: 25000, totalValue: 100000,
      paymentSchedule: [{ label: "A", percent: 50, amount: 37500 }, { label: "B", percent: 50, amount: 37500 }],
    });
    ok(balanced.res.code !== 500, "a PERCENTAGE schedule does not 500 — the TDZ regression, pinned");
    ok(!/before initialization/.test(balanced.res.body?.message || ""),
      "…specifically not 'Cannot access totalV before initialization'");
    ok(balanced.res.code === 200, "…and a schedule that adds up is accepted");

    // ── [B] the money is right ──
    console.log("\n[B. ₹25k advance on ₹1L splits the ₹75k BALANCE, not the ₹1L]");
    const bk = await VenueBooking.findById(balanced.res.body.booking._id).lean();
    const paid = bk.paymentSchedule.filter((r) => r.paidAmount > 0);
    const due = bk.paymentSchedule.filter((r) => !(r.paidAmount > 0));
    ok(paid.length === 1 && paid[0].paidAmount === 25000, "the token is one PAID row of ₹25,000");
    ok(due.reduce((s, r) => s + r.amount, 0) === 75000,
      "the instalments come to ₹75,000 — the balance after the advance");
    ok(paid[0].paidAmount + due.reduce((s, r) => s + r.amount, 0) === 100000,
      "THE WHOLE POINT: everything owed sums to the ₹1,00,000 booking, never ₹1,25,000");
    ok(bk.totalValue === 100000, "…and the booking value is the ₹1,00,000 that was agreed");

    // ── [C] the refusal ──
    console.log("\n[C. a schedule that does NOT add up is refused, with the arithmetic]");
    const over = await confirmWith({
      functions: fn(nextDate()), tokenAmount: 25000, totalValue: 100000,
      // 50/50 of the FULL value — the exact shape that over-collected.
      paymentSchedule: [{ label: "A", percent: 50, amount: 50000 }, { label: "B", percent: 50, amount: 50000 }],
    });
    ok(over.res.code === 400, "₹25k + ₹50k + ₹50k against a ₹1L booking is refused");
    ok(over.res.body.code === "schedule_value_mismatch", "…with a machine-readable code the portal can act on");
    ok(over.res.body.balance === 75000 && over.res.body.scheduledAmount === 100000,
      "…and the numbers to fix it: the ₹75,000 balance vs the ₹1,00,000 scheduled");
    ok(await VenueBooking.findOne({ enquiry: over.lead._id }) === null,
      "NOTHING IS WRITTEN on refusal — a rejected booking must not leave a half-made one");

    // ── [D] the old path still works ──
    console.log("\n[D. amounts-only schedules are unaffected]");
    const amounts = await confirmWith({
      functions: fn(nextDate()), tokenAmount: 10000, totalValue: 50000,
      paymentSchedule: [{ label: "A", amount: 40000 }],
    });
    ok(amounts.res.code === 200, "an amounts-only schedule with no percentages still confirms");

    const noTotal = await confirmWith({
      functions: fn(nextDate()), tokenAmount: 5000,
      paymentSchedule: [{ label: "A", percent: 100, amount: 45000 }],
    });
    ok(noTotal.res.code === 200, "a percentage schedule with NO declared total still confirms — the guard only checks what the caller stated");
    const derived = await VenueBooking.findById(noTotal.res.body.booking._id).lean();
    ok(derived.totalValue === 50000, "…and the total is derived from token + instalments, exactly as before");

    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error("FATAL", e);
    fail++;
  } finally {
    if (venue) {
      await VenueSpaceDate.deleteMany({ venue: venue._id });
      const leads = await VenueEnquiry.find({ venueId: venue._id }).select("_id").lean();
      await VenueBooking.deleteMany({ enquiry: { $in: leads.map((l) => l._id) } });
      await VenueEnquiry.deleteMany({ venueId: venue._id });
      await Venue.deleteOne({ _id: venue._id });
    }
    if (owner) await VenueOwner.deleteOne({ _id: owner._id });
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
