// THE MILESTONE BRANCH, GATED — the ungated door that produced INV0005.
// Run: DATABASE_URL=... node tests/venue-milestone-gst-first.test.js
//
// On a GST-first booking, a milestone invoice RENDERS the stream
// decomposition the schedule and confirmation already print — the owner's
// checkbox can neither conjure nor strip tax, the kind follows the
// instalment's position, and the totals agree with the schedule's promise
// to the rupee.
require("dotenv").config();
const mongoose = require("mongoose");
const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueBooking = require("../models/VenueBooking");
const VenueInvoice = require("../models/VenueInvoice");
const ctrl = require("../controllers/venueLeadInvoice");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const TAG = `msgst-${Date.now()}`;

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const venue = await Venue.create({ name: `${TAG} Estate`, slug: `${TAG}-v`, gstin: "29AAECC1206D1ZL", pan: "AAECC1206D" });
    const lead = await VenueEnquiry.create({ venueId: venue._id, coupleName: "Asiya", couplePhone: "7259929228", stage: "booked", contacts: [{ name: "Asiya", phone: "7259929228", isPrimary: true }] });
    const booking = await VenueBooking.create({
      venue: venue._id, enquiry: lead._id, coupleName: "Asiya", status: "confirmed",
      gstPercent: 18, gstMode: "none", totalValue: 615000, scheduleIncludesGst: true,
      lineItems: [
        { label: "Venue rental", amount: 600000, gstTreatment: "part", taxableAmount: 200000, refundable: false },
        { label: "Cleaning", amount: 5000, gstTreatment: "none", taxableAmount: 0, refundable: false },
        { label: "Refundable deposit", amount: 25000, gstTreatment: "none", taxableAmount: 0, refundable: true },
        { label: "Additional furniture", amount: 10000, gstTreatment: "none", taxableAmount: 0, refundable: false },
      ],
      paymentSchedule: [
        { label: "Token — received (UPI)", amount: 100000, dueDate: new Date(), entries: [] },
        { label: "First instalment", amount: 192038, dueDate: new Date(), entries: [] },
        { label: "Balance", amount: 383962, dueDate: new Date(), entries: [] },
      ],
    });
    const call = async (body) => {
      const req = { params: { slug: venue.slug, enquiryId: String(lead._id) }, body, venueOwner: { venueOwnerId: new mongoose.Types.ObjectId(), venueId: venue._id } };
      const res = { status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
      await ctrl.createLeadInvoice(req, res);
      return res;
    };

    console.log("[the checkbox cannot double-tax a GST-first instalment]");
    // gst:true — the exact INV0005 request shape
    const r1 = await call({ milestoneId: String(booking.paymentSchedule[1]._id), gst: true });
    ok([200, 201, 502].includes(r1.code), `first instalment raised (${r1.code}; 502 = the S3-env baseline, invoice still stored)`);
    const inv1 = await VenueInvoice.findOne({ enquiry: lead._id, forMilestoneId: booking.paymentSchedule[1]._id }).lean();
    ok(Boolean(inv1), "…and stored");
    ok(inv1.totals.grandTotal === 192038, `🔴 the invoice bills the schedule's PROMISE — 1,92,038, never 2,26,605 (got ${inv1.totals.grandTotal})`);
    ok(inv1.totals.subtotal === 171292 && inv1.totals.taxable === 115254 && inv1.totals.gst === 20746,
      `…decomposed exactly as the confirmation prints (${inv1.totals.subtotal}/${inv1.totals.taxable}/${inv1.totals.gst})`);
    ok(inv1.lineItems[0].taxable === 115254 && inv1.lineItems[0].gst === 20746,
      "🔴 the LINE declares what the total taxes — no dashed line under a taxing total");
    ok(inv1.lineItems[0].label === "First instalment", "the line names the instalment alone — no couple suffix");
    ok(inv1.kind === "instalment", `kind follows position — a middle instalment is 'instalment' (got ${inv1.kind})`);

    console.log("\n[the checkbox cannot conjure tax on the untaxed stream]");
    const r2 = await call({ milestoneId: String(booking.paymentSchedule[2]._id), gst: true });
    ok([200, 201, 502].includes(r2.code), `balance raised (${r2.code})`);
    const inv2 = await VenueInvoice.findOne({ enquiry: lead._id, forMilestoneId: booking.paymentSchedule[2]._id }).lean();
    ok(inv2.totals.gst === 0 && inv2.totals.grandTotal === 383962,
      `gst:true conjured nothing — the balance is untaxed stream (${inv2.totals.gst}/${inv2.totals.grandTotal})`);
    ok(inv2.kind === "final", "…and the LAST instalment is 'final'");
    ok(inv2.gstMode === "none", "…stored as an ordinary (no-GST) shape");

    console.log("\n[the schedule's rows and the invoices agree — the cross-document promise]");
    const { decomposeGstInsideRows } = require("../utils/docsystem/shared");
    const { computeLineTotals } = require("../utils/venueMoney");
    const lf = computeLineTotals(booking.lineItems, 18);
    const rows = decomposeGstInsideRows(
      booking.paymentSchedule.map((r) => ({ amount: r.amount, ref: r._id })),
      { pct: 18, taxable: lf.taxable, gst: lf.gst, refundable: lf.refundable }
    );
    ok(rows[1].gst === inv1.totals.gst && rows[1].collectable === inv1.totals.grandTotal,
      "one implementation: the invoice's figures ARE the decomposition's");

    console.log("\n[old-model bookings keep the behaviour they were written with]");
    const oldBooking = await VenueBooking.create({
      venue: venue._id, enquiry: (await VenueEnquiry.create({ venueId: venue._id, coupleName: "Old Model", couplePhone: "9000000001", stage: "booked" }))._id,
      coupleName: "Old Model", status: "confirmed", gstMode: "whole", gstPercent: 18, totalValue: 100000,
      paymentSchedule: [{ label: "Advance", amount: 50000, dueDate: new Date(), entries: [] }],
    });
    const req3 = { params: { slug: venue.slug, enquiryId: String(oldBooking.enquiry) }, body: { milestoneId: String(oldBooking.paymentSchedule[0]._id), gst: true }, venueOwner: { venueOwnerId: new mongoose.Types.ObjectId(), venueId: venue._id } };
    const res3 = { status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await ctrl.createLeadInvoice(req3, res3);
    const inv3 = await VenueInvoice.findOne({ enquiry: oldBooking.enquiry }).lean();
    ok(inv3 && inv3.totals.subtotal === 50000 && inv3.totals.gst === 9000,
      `an old-model (ex-GST schedule) milestone still taxes on top as written (${inv3 && inv3.totals.gst})`);

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error("SUITE CRASHED:", e);
    process.exitCode = 1;
  } finally {
    try {
      const v = await Venue.findOne({ slug: new RegExp(`^${TAG}`) }).lean();
      if (v) {
        await VenueInvoice.deleteMany({ venue: v._id });
        await VenueBooking.deleteMany({ venue: v._id });
        await VenueEnquiry.deleteMany({ venueId: v._id });
        await Venue.deleteMany({ _id: v._id });
      }
    } catch (_) { /* disposable test DB */ }
    await mongoose.disconnect();
  }
})();
