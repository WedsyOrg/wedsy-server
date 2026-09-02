// MONEYPOST — the post-booking money surface, server side.
// Run: DATABASE_URL=... node tests/venue-moneypost.test.js
//
// S1: the quote door. Accepting a quote version on a lead whose booking has a
// payment schedule used to overwrite the confirmed booking's lineItems and
// totalValue with no schedule reconciliation. Now refused before any write.
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueQuote = require("../models/VenueQuote");
const VenueBooking = require("../models/VenueBooking");

const quotes = require("../controllers/venueQuote");
const { classifyBooking } = require("../scripts/assess-schedule-payable-drift");

const TAG = `mpost-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, r) => { const res = mockRes(); await fn(r, res); return res; };
const created = { venues: [] };

let venue;
const req = (extra = {}) => ({
  params: { slug: venue.slug, ...(extra.params || {}) },
  query: {}, body: extra.body || {},
  venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: new mongoose.Types.ObjectId() },
  venueMember: null,
});
const mkLead = (extra = {}) => VenueEnquiry.create({
  venueId: venue._id, coupleName: `${TAG} Couple`, couplePhone: `9${Math.floor(Math.random() * 1e9)}`,
  stage: "negotiating", activities: [], ...extra,
});

const LINES = [
  { label: "Venue hire", amount: 500000, gstTreatment: "full" },
  { label: "Security deposit", amount: 50000, gstTreatment: "none", refundable: true },
];

/** A confirmed line booking with its schedule built — payable 550000. */
async function mkConfirmedBooking(lead, { schedule } = {}) {
  return VenueBooking.create({
    venue: venue._id, enquiry: lead._id, coupleName: lead.coupleName, couplePhone: lead.couplePhone,
    status: "confirmed", totalValue: 500000, gstPercent: 18, gstMode: "none",
    lineItems: LINES.map((l) => ({ ...l, taxableAmount: 0, refundable: Boolean(l.refundable) })),
    paymentSchedule: schedule || [
      { label: "Token — received", amount: 100000, percent: null, dueDate: new Date(), entries: [{ amount: 100000, date: new Date(), method: "upi", status: "approved", approvedAt: new Date() }] },
      { label: "Instalment 2", amount: 200000, percent: null, dueDate: new Date(Date.now() + 7 * 864e5) },
      { label: "Instalment 3", amount: 250000, percent: null, dueDate: new Date(Date.now() + 30 * 864e5) },
    ],
  });
}

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    venue = await Venue.create({ name: `${TAG}-v`, slug: `${TAG}-v` });
    created.venues.push(venue._id);

    // ══ S1-A. THE DOOR IS CLOSED ════════════════════════════════════════════
    console.log("\n[S1-A. accepting a quote version cannot rewrite a scheduled booking]");
    const lead = await mkLead();
    const booking = await mkConfirmedBooking(lead);
    let r = await call(quotes.createQuote, req({
      body: { enquiry: String(lead._id), gstPercent: 18, lineItems: [{ label: "Venue hire", amount: 900000, gstTreatment: "full" }] },
    }));
    eq(r.code, 201, "a NEW quote version can still be drafted (history is not frozen)");
    const q2 = r.body.quote;
    r = await call(quotes.updateQuote, req({ params: { quoteId: String(q2._id) }, body: { status: "accepted" } }));
    eq(r.code, 409, "🔴 accepting it is REFUSED — the booking's schedule is built");
    eq(r.body.code, "booking_has_schedule", "…with the machine-readable code");
    ok(/unpaid instalments/.test(r.body.message), "…and the refusal names the sanctioned path (the line edit)");
    const bAfter = await VenueBooking.findById(booking._id).lean();
    eq(bAfter.totalValue, 500000, "🔴 the booking's totalValue is untouched");
    eq(bAfter.lineItems[0].amount, 500000, "🔴 the booking's lines are untouched");
    const qAfter = await VenueQuote.findById(q2._id).lean();
    eq(qAfter.status, "draft", "🔴 the quote did NOT flip to accepted (no half-landed acceptance)");

    r = await call(quotes.confirmBookingFromQuote, req({ params: { quoteId: String(q2._id) } }));
    eq(r.code, 409, "confirm-from-quote takes the same door: 409 (not accepted is masked by the earlier check order)");

    // ══ S1-B. THE NORMAL ACCEPT FLOW STILL WORKS ════════════════════════════
    console.log("\n[S1-B. pre-schedule acceptance is unchanged]");
    const lead2 = await mkLead();
    r = await call(quotes.createQuote, req({
      body: { enquiry: String(lead2._id), gstPercent: 18, lineItems: [{ label: "Venue hire", amount: 300000, gstTreatment: "full" }] },
    }));
    const q3 = r.body.quote;
    r = await call(quotes.updateQuote, req({ params: { quoteId: String(q3._id) }, body: { status: "accepted" } }));
    eq(r.code, 200, "a lead with NO scheduled booking accepts exactly as before");
    ok(r.body.booking && r.body.booking.totalValue === 300000, "…and the draft booking takes the quote's charged figure");

    // ══ S1-C. THE ASSESS CLASSIFIER ═════════════════════════════════════════
    console.log("\n[S1-C. assess-schedule-payable-drift classifier]");
    const c1 = classifyBooking({ lineItems: [], paymentSchedule: [{ amount: 5 }] }, null);
    eq(c1.verdict, "no_lines", "legacy booking → no_lines (invariant does not apply)");
    const c2 = classifyBooking({ lineItems: LINES, paymentSchedule: [] }, null);
    eq(c2.verdict, "no_schedule", "money-less confirm → no_schedule (invariant vacuous)");
    const c3 = classifyBooking({ lineItems: LINES, gstPercent: 18, paymentSchedule: [
      { amount: 100000 }, { amount: 200000 }, { amount: 250000 }, { amount: 40000, isAdditional: true },
    ] }, null);
    eq(c3.verdict, "consistent", "Σ non-additional 550000 === payable 550000 → consistent (additional excluded)");
    const c4 = classifyBooking({ lineItems: LINES, gstPercent: 18, paymentSchedule: [
      { amount: 100000 }, { amount: 200000 },
    ] }, { totals: { charged: 500000 } });
    eq(c4.verdict, "drifted", "short schedule → drifted");
    eq(c4.delta, -250000, "…delta says HOW short");
    eq(c4.quoteFingerprint, true, "…lines matching the newest accepted quote = the door's fingerprint");
    const c5 = classifyBooking({ lineItems: LINES, gstPercent: 18, paymentSchedule: [{ amount: 100000 }] }, { totals: { charged: 999999 } });
    eq(c5.quoteFingerprint, false, "…lines matching no accepted quote = other hand");

    // ══ S3. POST-BOOKING LINE EDITS, ABSORBED INTO WHAT IS UNPAID ═══════════
    const { planAbsorb, bookingLineEdit } = require("../controllers/venueBookingMoney");
    console.log("\n[S3-A. planAbsorb — the arithmetic, proven without a database]");
    const rowsFx = [
      { amount: 100000, entries: [{ amount: 100000, status: "approved", date: new Date() }] }, // token, paid
      { amount: 200000, entries: [] },
      { amount: 250000, entries: [] },
      { amount: 40000, isAdditional: true, entries: [] },
    ];
    let pl = planAbsorb(rowsFx, 650000);
    ok(pl.ok, "increase to 650000 plans");
    eq(pl.rows.map((r) => r.to).join(","), "100000,244444,305556", "🔴 token frozen; open rows absorb in outstanding shares; last row settles rounding");
    eq(pl.rows.reduce((s, r) => s + r.to, 0), 650000, "🔴 Σ lands EXACTLY on the new payable — the guard holds by construction");
    ok(pl.rows[0].frozen, "the paid token is frozen");
    pl = planAbsorb(rowsFx, 450000);
    eq(pl.rows.map((r) => r.to).join(","), "100000,155556,194444", "decrease shrinks the open rows between them");
    pl = planAbsorb([
      rowsFx[0],
      { amount: 200000, entries: [{ amount: 50000, status: "approved", date: new Date() }] },
      { amount: 250000, entries: [] },
    ], 250000);
    eq(pl.rows.map((r) => r.to).join(","), "100000,87500,62500", "🔴 a part-paid row never shrinks below what it received (floor 50000 held: 87500 ≥ 50000)");
    pl = planAbsorb(rowsFx, 90000);
    eq(pl.ok, false, "below collected refuses");
    eq(pl.code, "refund_required", "…as a refund");
    eq(pl.collected, 100000, "…naming what was collected");
    pl = planAbsorb([rowsFx[0]], 200000);
    eq(pl.code, "all_instalments_cleared", "every instalment cleared → the increase has nowhere to land");
    pl = planAbsorb([rowsFx[0]], 100000);
    ok(pl.ok && pl.rows.every((r) => r.to === r.from), "…but an equal total is a clean no-op");

    console.log("\n[S3-B. the endpoint — preview, confirm, guard, write-back]");
    const lead3 = await mkLead();
    const bk3 = await mkConfirmedBooking(lead3);
    const editReq = (body) => req({ params: { enquiryId: String(lead3._id) }, body });
    const NEW_LINES = [
      { label: "Venue hire", amount: 600000, gstTreatment: "full" },
      { label: "Security deposit", amount: 50000, gstTreatment: "none", refundable: true },
    ];
    r = await call(bookingLineEdit, editReq({ lineItems: NEW_LINES }));
    eq(r.code, 200, "preview answers");
    eq(r.body.preview, true, "…and is a PREVIEW");
    eq(r.body.agreed.from, 500000, "before: agreed 500000");
    eq(r.body.agreed.to, 600000, "after: agreed 600000");
    ok(r.body.rows.length === 3 && r.body.rows[0].frozen, "per-instalment before/after, token frozen");
    let bCheck = await VenueBooking.findById(bk3._id).lean();
    eq(bCheck.totalValue, 500000, "🔴 preview wrote NOTHING");
    r = await call(bookingLineEdit, editReq({ lineItems: NEW_LINES, confirm: true }));
    eq(r.code, 200, "confirm applies");
    bCheck = await VenueBooking.findById(bk3._id).lean();
    eq(bCheck.totalValue, 600000, "🔴 totalValue follows the lines");
    eq(bCheck.lineItems[0].amount, 600000, "lines stored");
    eq(bCheck.paymentSchedule.filter((x) => !x.isAdditional).reduce((s2, x) => s2 + x.amount, 0), 650000,
      "🔴 Σ non-additional rows === new payable — invariant by construction");
    eq(bCheck.paymentSchedule[0].amount, 100000, "the paid token row is untouched");
    const lCheck = await VenueEnquiry.findById(lead3._id).lean();
    eq(lCheck.estimatedValue, 600000, "🔴 estimatedValue write-back follows, like confirm's");
    ok(lCheck.activities.some((x) => x.type === "booking_lines_edited"), "…and the act is on the trail");

    r = await call(bookingLineEdit, editReq({ lineItems: [{ label: "Venue hire", amount: 40000, gstTreatment: "none" }], confirm: true }));
    eq(r.code, 409, "reducing below what was collected refuses");
    eq(r.body.code, "refund_required", "…as the refund case");
    ok(/collected/.test(r.body.message) && /40,000/.test(r.body.message), "…naming both figures");
    bCheck = await VenueBooking.findById(bk3._id).lean();
    eq(bCheck.totalValue, 600000, "…and nothing moved");

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error("SUITE CRASHED:", e);
    process.exitCode = 1;
  } finally {
    try {
      await VenueBooking.deleteMany({ venue: { $in: created.venues } });
      await VenueQuote.deleteMany({ venue: { $in: created.venues } });
      await VenueEnquiry.deleteMany({ venueId: { $in: created.venues } });
      await Venue.deleteMany({ _id: { $in: created.venues } });
    } catch (_) { /* fresh test DBs are disposable */ }
    await mongoose.disconnect();
  }
})();
