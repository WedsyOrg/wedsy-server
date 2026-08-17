// Booking engine S4 — recording payments, and the balance agreeing everywhere.
// Run: node tests/venue-lead-payment.test.js
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueOwner = require("../models/VenueOwner");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueBooking = require("../models/VenueBooking");

const lp = require("../controllers/venueLeadPayment");
const vp = require("../controllers/venuePayment");
const { summarizeSchedule, milestoneStatus, overdueSentence } = require("../utils/venuePaymentStatus");

const TAG = `lpay-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const created = { venues: [], owners: [] };
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const daysAhead = (n) => new Date(Date.now() + n * 86400000);

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    const venue = await Venue.create({ name: `${TAG} Palace`, slug: `${TAG}-v`, city: "Bangalore", state: "Karnataka" });
    created.venues.push(venue._id);
    const owner = await VenueOwner.create({ venueId: venue._id, name: "Owner", phone: `${TAG}o`, isActive: true });
    created.owners.push(owner._id);
    const lead = await VenueEnquiry.create({
      venueId: venue._id, coupleName: "Priya & Arjun", coupleNameManual: true,
      couplePhone: "9800001111", stage: "booked",
    });
    const booking = await VenueBooking.create({
      venue: venue._id, enquiry: lead._id, coupleName: "Priya & Arjun", totalValue: 1200000,
      days: [{ date: daysAhead(60), eventType: "wedding", guestCount: 300 }],
      paymentSchedule: [
        { label: "Advance", amount: 400000, percent: 33.34, dueDate: daysAgo(12) },
        { label: "Second instalment", amount: 400000, percent: 33.33, dueDate: daysAhead(10) },
        { label: "Balance", amount: 400000, percent: 33.33, dueDate: daysAhead(53) },
      ],
    });

    const req = (extra = {}) => ({
      params: { slug: venue.slug, enquiryId: String(lead._id), ...(extra.params || {}) },
      query: {}, body: extra.body || {},
      venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: owner._id },
      venueMember: null,
    });

    // ══ THE DERIVATION ══════════════════════════════════════════════════════
    console.log("\n[status is derived from paidAmount vs amount vs dueDate]");
    ok(milestoneStatus({ amount: 100, paidAmount: 100 }) === "paid", "fully paid → paid");
    ok(milestoneStatus({ amount: 100, paidAmount: 40, dueDate: daysAhead(5) }) === "partial", "part paid, not yet due → partial");
    ok(milestoneStatus({ amount: 100, paidAmount: 0, dueDate: daysAhead(5) }) === "due", "unpaid, not yet due → due");
    ok(milestoneStatus({ amount: 100, paidAmount: 0, dueDate: daysAgo(1) }) === "overdue", "unpaid and late → overdue");
    ok(milestoneStatus({ amount: 100, paidAmount: 40, dueDate: daysAgo(1) }) === "overdue",
      "PART paid but late is still overdue — part-payment does not make it on time");
    ok(milestoneStatus({ amount: 100, paidAmount: 100, dueDate: daysAgo(9) }) === "paid", "fully paid stays paid even when it was late");

    console.log("\n[before any payment]");
    const before = await call(lp.getLeadPayments, req());
    ok(before.code === 200 && before.body.hasBooking === true, "the schedule reads → 200");
    ok(before.body.totals.balance === 1200000, "balance is the full booking value");
    ok(before.body.totals.received === 0, "nothing received yet");
    ok(before.body.overdue.length === 1, "one instalment is overdue (the advance, 12 days ago)");
    ok(before.body.overdue[0].daysLate === 12, `…and it knows it is 12 days late (got ${before.body.overdue[0].daysLate})`);
    ok(before.body.next && before.body.next.label === "Advance", "…and the next thing owed is that same advance");
    ok(before.body.totals.scheduleMatchesValue === true, "the schedule adds up to the booking value");

    // ══ RECORDING ═══════════════════════════════════════════════════════════
    console.log("\n[recording a payment]");
    const b = await VenueBooking.findById(booking._id);
    const m1 = b.paymentSchedule[0];
    const partial = await call(lp.recordPayment, req({ body: {
      milestoneId: String(m1._id), amount: 250000, mode: "upi", reference: "UPI-77812",
    } }));
    ok(partial.code === 200, "a PARTIAL payment is accepted");
    ok(partial.body.milestone.paidAmount === 250000, "…recorded against the instalment");
    ok(partial.body.milestone.amount === 400000, "…while the instalment keeps its ORIGINAL amount");
    ok(partial.body.milestone.outstanding === 150000, "…leaving 1,50,000 outstanding on it");
    ok(partial.body.milestone.status === "overdue", "…and it stays overdue, because part-payment of a late instalment is still late");
    ok(partial.body.totals.balance === 950000, "the booking balance drops to 9,50,000");
    ok(partial.body.totals.received === 250000, "…and received rises to 2,50,000");
    ok(partial.body.milestone.paidMode === "upi" && partial.body.milestone.paidReference === "UPI-77812", "method and reference are kept");
    ok(partial.body.milestone.recordedByName === "Owner", "…and who recorded it");

    const rest = await call(lp.recordPayment, req({ body: { milestoneId: String(m1._id), amount: 150000, mode: "cash" } }));
    ok(rest.code === 200 && rest.body.milestone.status === "paid", "paying the remainder completes the instalment");
    ok(rest.body.milestone.paidAmount === 400000, "…totalling the full amount");
    ok(rest.body.totals.balance === 800000, "…and the balance falls again");
    ok(rest.body.overdue.length === 0, "…and nothing is overdue any more");

    console.log("\n[the overpayment guard]");
    const over = await call(lp.recordPayment, req({ body: { milestoneId: String(m1._id), amount: 1 } }));
    ok(over.code === 400 && over.body.code === "overpays_milestone", "paying more than an instalment needs is refused");
    ok(/outstanding on it/.test(over.body.message), "…naming what is actually outstanding");
    const stillEight = await call(lp.getLeadPayments, req());
    ok(stillEight.body.totals.balance === 800000, "…and the balance was not moved by the refused payment");

    for (const [amount, why] of [[0, "zero"], [-5, "a negative amount"], ["abc", "a non-number"]]) {
      const r = await call(lp.recordPayment, req({ body: { milestoneId: String(m1._id), amount } }));
      ok(r.code === 400, `refused: ${why}`);
    }
    const badMs = await call(lp.recordPayment, req({ body: { milestoneId: String(new mongoose.Types.ObjectId()), amount: 100 } }));
    ok(badMs.code === 404, "a milestone not on this booking → 404");

    // ══ THE SAME NUMBERS EVERYWHERE ═════════════════════════════════════════
    console.log("\n[the lead, the util and the alerts agree — one derivation]");
    const fresh = await VenueBooking.findById(booking._id).lean();
    const util = summarizeSchedule(fresh);
    const leadView = await call(lp.getLeadPayments, req());
    ok(util.totals.balance === leadView.body.totals.balance, `balance matches between the util and the lead (${util.totals.balance})`);
    ok(util.totals.received === leadView.body.totals.received, "received matches");
    ok(util.overdue.length === leadView.body.overdue.length, "the overdue list matches");

    // Make the second instalment late so the alert surface has something to say.
    const b2 = await VenueBooking.findById(booking._id);
    b2.paymentSchedule[1].dueDate = daysAgo(3);
    await b2.save();

    const summaryRes = await call(vp.summary, { params: { slug: venue.slug }, query: {},
      venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: owner._id }, venueMember: null });
    ok(summaryRes.code === 200, "the existing payments summary still responds");
    const mine = (summaryRes.body.overdue || []).filter((o) => String(o.bookingId) === String(booking._id));
    ok(mine.length === 1, `it reports exactly the ONE genuinely overdue instalment (got ${mine.length})`);
    ok(mine[0].label === "Second instalment", "…naming which instalment");
    ok(mine[0].daysLate === 3, `…how many days late (${mine[0].daysLate})`);
    ok(mine[0].outstanding === 400000, "…and what is still outstanding on it");
    ok(/Second instalment/.test(mine[0].sentence) && /3 days late/.test(mine[0].sentence),
      `…in one actionable sentence: "${mine[0].sentence}"`);
    // The old behaviour would have flagged the PAID advance too, because the
    // booking balance is still non-zero. That is the bug this slice removes.
    ok(!mine.some((o) => o.label === "Advance"), "the fully-paid advance is NOT reported overdue any more");

    console.log("\n[a partially paid, late instalment reads honestly]");
    const b3 = await VenueBooking.findById(booking._id);
    await call(lp.recordPayment, req({ body: { milestoneId: String(b3.paymentSchedule[1]._id), amount: 100000 } }));
    const s2 = await call(vp.summary, { params: { slug: venue.slug }, query: {},
      venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: owner._id }, venueMember: null });
    const m2 = (s2.body.overdue || []).find((o) => o.label === "Second instalment");
    ok(m2 && m2.outstanding === 300000, "it still chases the REMAINING 3,00,000, not the original 4,00,000");
    ok(/of Rs. 4,00,000 received/.test(m2.sentence), `…and says what has already arrived: "${m2.sentence}"`);

    // ══ DENY SWEEP ══════════════════════════════════════════════════════════
    console.log("\n[deny sweep]");
    const beforeBal = (await VenueBooking.findById(booking._id).lean()).paymentSchedule.reduce((s, r) => s + (r.paidAmount || 0), 0);
    for (const [fn, name] of [[lp.getLeadPayments, "GET payments"], [lp.recordPayment, "POST payments"]]) {
      const r = await call(fn, req({ params: { enquiryId: String(new mongoose.Types.ObjectId()) }, body: { milestoneId: String(m1._id), amount: 100 } }));
      ok(r.code === 404, `${name} for a lead outside scope → 404`);
    }
    const afterBal = (await VenueBooking.findById(booking._id).lean()).paymentSchedule.reduce((s, r) => s + (r.paidAmount || 0), 0);
    ok(beforeBal === afterBal, "…and no denied call moved a single rupee");

    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error("FATAL", e);
    fail++;
  } finally {
    for (const v of created.venues) {
      await VenueBooking.deleteMany({ venue: v });
      await VenueEnquiry.deleteMany({ venueId: v });
      await Venue.deleteOne({ _id: v });
    }
    await VenueOwner.deleteMany({ _id: { $in: created.owners } });
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
