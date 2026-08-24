// Money model S2 — a payment cascades down the schedule, and the owner sees
// where it lands BEFORE it is saved.
//
// The load-bearing property is that the PREVIEW AND THE WRITE AGREE. A preview
// that is computed separately from the write eventually disagrees with it, and
// then it is a decoration that lies about money. Several tests below run the
// preview and the write with the same input and compare them line for line.
//
// Run: node tests/venue-payment-waterfall.test.js
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueOwner = require("../models/VenueOwner");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueBooking = require("../models/VenueBooking");

const lp = require("../controllers/venueLeadPayment");
const { summarizeSchedule, receivedOn } = require("../utils/venuePaymentStatus");
const { allocate, allocationSentence, orderRows } = require("../utils/venuePaymentWaterfall");

const TAG = `wfall-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const created = { venues: [], owners: [], leads: [], bookings: [] };
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const daysAhead = (n) => new Date(Date.now() + n * 86400000);

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    // ══ THE PLANNER, PURE ═══════════════════════════════════════════════════
    const rows = [
      { _id: "a", label: "Instalment 1", amount: 100000, outstanding: 50000, dueDate: "2026-01-01" },
      { _id: "b", label: "Instalment 2", amount: 100000, outstanding: 100000, dueDate: "2026-02-01" },
      { _id: "c", label: "Balance", amount: 100000, outstanding: 100000, dueDate: "2026-03-01" },
    ];

    console.log("\n[the waterfall fills oldest-first, and carries the remainder]");
    const p1 = allocate(rows, 50000);
    ok(p1.lines.length === 1 && p1.lines[0].amount === 50000 && p1.lines[0].completes, "₹50k completes instalment 1 and stops there");
    const p2 = allocate(rows, 100000);
    ok(p2.lines.length === 2, "₹1L spans two instalments");
    ok(p2.lines[0].amount === 50000 && p2.lines[0].completes === true, "…50,000 COMPLETES the first");
    ok(p2.lines[1].amount === 50000 && p2.lines[1].completes === false, "…50,000 only starts the second");
    ok(
      allocationSentence(p2, 100000) === "Rs. 1,00,000 → Rs. 50,000 completes Instalment 1, Rs. 50,000 to Instalment 2.",
      `the sentence reads as specified — "${allocationSentence(p2, 100000)}"`
    );
    const p3 = allocate(rows, 25000);
    ok(p3.lines.length === 1 && p3.lines[0].amount === 25000 && !p3.lines[0].completes, "a partial leaves the instalment outstanding");
    ok(/to Instalment 1/.test(allocationSentence(p3, 25000)), "…and the sentence says 'to', not 'completes'");
    const p4 = allocate(rows, 250000);
    ok(p4.lines.length === 3 && p4.allocated === 250000, "a payment can span the whole schedule");

    console.log("\n[an undated row sorts LAST so it cannot swallow an overdue one]");
    const mixed = [
      { _id: "u", label: "Ad-hoc", amount: 10000, outstanding: 10000, dueDate: null },
      { _id: "d", label: "Overdue one", amount: 10000, outstanding: 10000, dueDate: "2026-01-01" },
    ];
    ok(orderRows(mixed)[0]._id === "d", "the dated row is filled first");
    ok(allocate(mixed, 10000).lines[0].label === "Overdue one", "…so ₹10k clears the overdue instalment, not the ad-hoc one");

    console.log("\n[ties keep the owner's schedule order]");
    const tied = [
      { _id: "t1", label: "First typed", amount: 100, outstanding: 100, dueDate: "2026-01-01" },
      { _id: "t2", label: "Second typed", amount: 100, outstanding: 100, dueDate: "2026-01-01" },
    ];
    ok(orderRows(tied)[0]._id === "t1", "same due date → schedule order is preserved");

    console.log("\n[the override wins — the waterfall is a default, not a cage]");
    const ov = allocate(rows, 100000, [{ milestoneId: "c", amount: 100000 }]);
    ok(!ov.error && ov.lines.length === 1 && String(ov.lines[0].milestoneId) === "c", "'this is for the final instalment' is honoured");
    const split = allocate(rows, 100000, [{ milestoneId: "a", amount: 30000 }, { milestoneId: "b", amount: 70000 }]);
    ok(!split.error && split.lines.length === 2, "an explicit split is honoured");
    ok(split.lines[0].amount === 30000 && split.lines[1].amount === 70000, "…exactly as the owner allocated it");

    console.log("\n[refusals name the number, and do not silently allocate less]");
    const overAll = allocate(rows, 300000);
    ok(overAll.error && overAll.error.code === "overpays_schedule", "more than the whole schedule → refused");
    ok(/2,50,000/.test(overAll.error.message), "…naming what is actually left to collect");
    ok(overAll.lines.length === 0, "…and allocating nothing at all");
    const overOne = allocate(rows, 100000, [{ milestoneId: "a", amount: 100000 }]);
    ok(overOne.error && overOne.error.code === "overpays_milestone", "an override may not overpay the instalment it names");
    const mismatch = allocate(rows, 100000, [{ milestoneId: "a", amount: 20000 }]);
    ok(mismatch.error && mismatch.error.code === "allocation_mismatch", "a split that does not add up to the payment → refused");
    ok(/20,000/.test(mismatch.error.message) && /1,00,000/.test(mismatch.error.message), "…naming BOTH numbers");
    const settled = allocate([{ _id: "z", label: "Done", amount: 100, outstanding: 0 }], 5000);
    ok(settled.error && /additional billing/.test(settled.error.message), "a fully-paid booking points at additional billing (S5)");

    // ══ THROUGH THE REAL HANDLERS ═══════════════════════════════════════════
    const venue = await Venue.create({ name: `${TAG} Palace`, slug: `${TAG}-v`, city: "Bangalore", state: "Karnataka" });
    created.venues.push(venue._id);
    const owner = await VenueOwner.create({ venueId: venue._id, name: "Owner", phone: `${TAG}o`, isActive: true });
    created.owners.push(owner._id);
    const lead = await VenueEnquiry.create({
      venueId: venue._id, coupleName: "Priya & Arjun", coupleNameManual: true, couplePhone: "9800001111", stage: "booked",
    });
    created.leads.push(lead._id);
    const booking = await VenueBooking.create({
      venue: venue._id, enquiry: lead._id, coupleName: "Priya & Arjun", totalValue: 300000,
      days: [{ date: daysAhead(60), eventType: "wedding", guestCount: 300 }],
      paymentSchedule: [
        { label: "Instalment 1", amount: 100000, dueDate: daysAgo(10), entries: [{ amount: 50000, status: "approved" }] },
        { label: "Instalment 2", amount: 100000, dueDate: daysAhead(20) },
        { label: "Balance", amount: 100000, dueDate: daysAhead(50) },
      ],
    });
    created.bookings.push(booking._id);

    const req = (extra = {}) => ({
      params: { slug: venue.slug, enquiryId: String(lead._id), ...(extra.params || {}) },
      query: {}, body: extra.body || {},
      venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: owner._id },
      venueMember: null,
    });

    console.log("\n[the preview answers before anything is saved]");
    const pv = await call(lp.previewPayment, req({ body: { amount: 100000 } }));
    ok(pv.code === 200 && pv.body.ok === true, "preview 200");
    ok(pv.body.sentence === "Rs. 1,00,000 → Rs. 50,000 completes Instalment 1, Rs. 50,000 to Instalment 2.", `sentence: "${pv.body.sentence}"`);
    ok(pv.body.balanceAfter === 150000, "…and says what the balance would become");
    const untouched = await VenueBooking.findById(booking._id);
    ok(summarizeSchedule(untouched).totals.received === 50000, "THE PREVIEW WROTE NOTHING");

    console.log("\n[a refusal at preview time is information, not a failed request]");
    const pvBad = await call(lp.previewPayment, req({ body: { amount: 9999999 } }));
    ok(pvBad.code === 200, "over-payment preview is still a 200");
    ok(pvBad.body.ok === false && pvBad.body.problem.code === "overpays_schedule", "…carrying the reason it would be refused");
    ok(pvBad.body.sentence === "", "…and no sentence, because there is no allocation to describe");

    console.log("\n[the write does exactly what the preview showed]");
    const rec = await call(lp.recordPayment, req({ body: { amount: 100000, mode: "bank_transfer", reference: "NEFT-77" } }));
    ok(rec.code === 200, `record 200 (got ${rec.code} ${rec.body && rec.body.message ? rec.body.message : ""})`);
    const after = await VenueBooking.findById(booking._id);
    const s = summarizeSchedule(after);
    ok(s.totals.received === 150000, "received is now 1,50,000");
    ok(s.rows[0].status === "paid", "instalment 1 is complete");
    ok(s.rows[1].paidAmount === 50000, "instalment 2 has 50,000 against it");
    ok(s.rows[1].status !== "paid", "…and is still outstanding");
    ok(s.totals.balance === pv.body.balanceAfter, "the balance is exactly what the preview predicted");

    console.log("\n[one payment spanning two instalments stays ONE payment]");
    const e1 = after.paymentSchedule[0].entries.find((e) => e.reference === "NEFT-77");
    const e2 = after.paymentSchedule[1].entries.find((e) => e.reference === "NEFT-77");
    ok(!!e1 && !!e2, "it produced an entry on each instalment");
    ok(String(e1.paymentId) === String(e2.paymentId), "…sharing one paymentId");
    ok(!!e1.paymentId, "…which is actually set");

    console.log("\n[the timeline describes the whole allocation, not one milestone]");
    const freshLead = await VenueEnquiry.findById(lead._id);
    const act = (freshLead.activities || []).filter((a) => a.type === "payment_recorded").pop();
    ok(!!act, "an activity was logged");
    ok(/completes Instalment 1/.test(act.description) && /to Instalment 2/.test(act.description), `it names both — "${act.description}"`);

    console.log("\n[the override path, end to end]");
    const ovPv = await call(lp.previewPayment, req({ body: { amount: 50000, allocations: [{ milestoneId: String(after.paymentSchedule[2]._id), amount: 50000 }] } }));
    ok(ovPv.body.ok === true && /Balance/.test(ovPv.body.sentence), "preview honours 'this is for the final instalment'");
    const ovRec = await call(lp.recordPayment, req({ body: { amount: 50000, allocations: [{ milestoneId: String(after.paymentSchedule[2]._id), amount: 50000 }], mode: "upi" } }));
    ok(ovRec.code === 200, "record honours it too");
    const after2 = await VenueBooking.findById(booking._id);
    ok(receivedOn(after2.paymentSchedule[2]) === 50000, "the money landed on the Balance, NOT on instalment 2");
    ok(receivedOn(after2.paymentSchedule[1]) === 50000, "…and instalment 2 was left exactly as it was");

    console.log("\n[the old single-milestone caller keeps working unchanged]");
    const legacyCall = await call(lp.recordPayment, req({ body: { milestoneId: String(after2.paymentSchedule[1]._id), amount: 50000, mode: "cash" } }));
    ok(legacyCall.code === 200, "{ milestoneId, amount } still records");
    const after3 = await VenueBooking.findById(booking._id);
    ok(receivedOn(after3.paymentSchedule[1]) === 100000, "…all of it against the named instalment");
    const legacyOver = await call(lp.recordPayment, req({ body: { milestoneId: String(after3.paymentSchedule[2]._id), amount: 999999 } }));
    ok(legacyOver.code === 400, "…and still refuses to overpay");

    console.log("\n[overpaying the whole booking is refused at the write too]");
    const tooMuch = await call(lp.recordPayment, req({ body: { amount: 500000 } }));
    ok(tooMuch.code === 400 && tooMuch.body.code === "overpays_schedule", `400 overpays_schedule (got ${tooMuch.code})`);
    const after4 = await VenueBooking.findById(booking._id);
    ok(summarizeSchedule(after4).totals.received === 250000, "…and not a rupee moved");

    console.log("\n[deny sweep — the new preview surface is scoped like every other lead read]");
    const otherVenue = await Venue.create({ name: `${TAG} Other`, slug: `${TAG}-o`, city: "Bangalore", state: "Karnataka" });
    created.venues.push(otherVenue._id);
    const outsider = await VenueOwner.create({ venueId: otherVenue._id, name: "Outsider", phone: `${TAG}x`, isActive: true });
    created.owners.push(outsider._id);
    const denied = await call(lp.previewPayment, {
      params: { slug: venue.slug, enquiryId: String(lead._id) }, query: {}, body: { amount: 1000 },
      venueOwner: { type: "venue_owner", venueId: otherVenue._id, venueOwnerId: outsider._id }, venueMember: null,
    });
    ok(denied.code === 404, `preview for a lead outside scope → 404 not 403 (got ${denied.code})`);
    const after5 = await VenueBooking.findById(booking._id);
    ok(summarizeSchedule(after5).totals.received === 250000, "…and the denied call moved nothing");
  } catch (err) {
    fail += 1;
    console.error("\nFATAL", err);
  } finally {
    try {
      await VenueBooking.deleteMany({ _id: { $in: created.bookings } });
      await VenueEnquiry.deleteMany({ _id: { $in: created.leads } });
      await VenueOwner.deleteMany({ _id: { $in: created.owners } });
      await Venue.deleteMany({ _id: { $in: created.venues } });
    } catch (e) { /* best effort */ }
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  }
})();
