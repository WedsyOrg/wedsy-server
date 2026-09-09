/**
 * ============================================================================
 * READ-ONLY ASSESS — find milestone invoices cut on GST-FIRST bookings whose
 * totals disagree with what the booking's schedule promises for that
 * instalment (the ungated milestone branch billed 18% ON TOP of a stored
 * amount that already included GST — INV0005's Rs. 34,567 over-bill).
 *
 * THIS SCRIPT MAKES ZERO WRITES. It only reads (.lean()) and prints.
 * There is NO .save / .create / .insert* / .update* / .replace* / .delete* /
 * .remove / .bulkWrite / .findOneAndUpdate / .findOneAndDelete anywhere in
 * this file. Investigation only — remediation (credit notes, reissues) is a
 * separate, deliberate step after Rohaan reads the numbers.
 *
 * Connection reuses the app's canonical bootstrap: mongoose.connect on
 * process.env.DATABASE_URL (same env var server.js uses). No URI is
 * hardcoded — on EC2 this env resolves to PROD, which is the point of
 * running it there.
 *
 * Run the prod scan (on the box):  node scripts/assess-doubled-gst-invoices.js
 * Verify bucketing, NO DB:         node scripts/assess-doubled-gst-invoices.js --self-check
 * ============================================================================
 */
require("dotenv").config();
const mongoose = require("mongoose");

// THE ONE decomposition — the same implementation the schedule, the
// confirmation and (post-fix) the invoice cutter read. If it drifts, this
// assessment drifts with it, which is correct: "what the fixed code would
// bill" is the standard a stored invoice is judged against.
const { decomposeGstInsideRows } = require("../utils/docsystem/shared");
const { computeLineTotals } = require("../utils/venueMoney");

/** Pure classification: one stored invoice vs its booking's promise. */
function classify(inv, booking) {
  if (!inv.forMilestoneId) return { bucket: "SKIP", why: "not a milestone invoice" };
  if (!booking) return { bucket: "ORPHAN", inv: inv.invoiceNumber, why: "booking missing" };
  if (!booking.scheduleIncludesGst) return { bucket: "OLD_MODEL_OK", inv: inv.invoiceNumber };
  const agreed = (booking.paymentSchedule || []).filter((r) => !r.isAdditional);
  const milestone = agreed.find((r) => String(r._id) === String(inv.forMilestoneId));
  if (!milestone) {
    const extra = (booking.paymentSchedule || []).find((r) => String(r._id) === String(inv.forMilestoneId));
    if (extra) return { bucket: "ADDITIONAL_ROW", inv: inv.invoiceNumber };
    return { bucket: "ROW_GONE", inv: inv.invoiceNumber, why: "instalment no longer on the schedule" };
  }
  const lf = computeLineTotals(booking.lineItems || [], booking.gstPercent);
  const rows = decomposeGstInsideRows(
    agreed.map((r) => ({ amount: r.amount, ref: r._id })),
    { pct: Number(booking.gstPercent) || 18, taxable: lf.taxable, gst: lf.gst, refundable: lf.refundable }
  );
  const promised = rows.find((r) => String(r.ref) === String(inv.forMilestoneId));
  const stored = inv.totals || {};
  const storedGrand = Math.round(Number(stored.grandTotal) || 0);
  const storedSub = Math.round(Number(stored.subtotal) || 0);
  const storedGst = Math.round(Number(stored.gst) || 0);
  if (storedGrand === promised.collectable && storedGst === promised.gst) {
    return { bucket: "OK", inv: inv.invoiceNumber };
  }
  // the signature of the ungated branch: subtotal === the row's stored
  // amount (the collectable) with fresh GST stacked on top of it
  const rowAmount = Math.round(Number(milestone.amount) || 0);
  if (storedSub === rowAmount && storedGst > 0 && storedGrand === rowAmount + storedGst) {
    return {
      bucket: "DOUBLED",
      inv: inv.invoiceNumber,
      booking: String(booking._id).slice(-6).toUpperCase(),
      couple: booking.coupleName || "",
      instalment: milestone.label || "Instalment",
      billed: storedGrand,
      promised: promised.collectable,
      overBilledBy: storedGrand - promised.collectable,
    };
  }
  return {
    bucket: "MISMATCH",
    inv: inv.invoiceNumber,
    booking: String(booking._id).slice(-6).toUpperCase(),
    billed: storedGrand,
    promised: promised.collectable,
    delta: storedGrand - promised.collectable,
  };
}

// ── self-check: the buckets, no DB ──────────────────────────────────────────
if (process.argv.includes("--self-check")) {
  const booking = {
    _id: "65cafe0000000000000abcd1",
    scheduleIncludesGst: true,
    gstPercent: 18,
    coupleName: "Asiya",
    lineItems: [
      { label: "Venue rental", amount: 600000, gstTreatment: "part", taxableAmount: 200000 },
      { label: "Cleaning", amount: 5000, gstTreatment: "none" },
      { label: "Refundable deposit", amount: 25000, gstTreatment: "none", refundable: true },
      { label: "Additional furniture", amount: 10000, gstTreatment: "none" },
    ],
    paymentSchedule: [
      { _id: "m1", label: "Token", amount: 100000 },
      { _id: "m2", label: "First instalment", amount: 192038 },
      { _id: "m3", label: "Balance", amount: 383962 },
    ],
  };
  const doubled = classify({ forMilestoneId: "m2", invoiceNumber: "INV0005", totals: { subtotal: 192038, gst: 34567, grandTotal: 226605 } }, booking);
  const ok = classify({ forMilestoneId: "m2", invoiceNumber: "INV-OK", totals: { subtotal: 171292, taxable: 115254, gst: 20746, grandTotal: 192038 } }, booking);
  const oldOk = classify({ forMilestoneId: "m2", invoiceNumber: "INV-OLD", totals: { grandTotal: 999 } }, { ...booking, scheduleIncludesGst: false });
  console.log(JSON.stringify({ doubled, ok, oldOk }, null, 1));
  const pass = doubled.bucket === "DOUBLED" && doubled.overBilledBy === 34567 && ok.bucket === "OK" && oldOk.bucket === "OLD_MODEL_OK";
  console.log(pass ? "\nSELF-CHECK PASS" : "\nSELF-CHECK FAIL");
  process.exit(pass ? 0 : 1);
}

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  const VenueInvoice = require("../models/VenueInvoice");
  const VenueBooking = require("../models/VenueBooking");
  const invoices = await VenueInvoice.find({ forMilestoneId: { $ne: null } }).lean();
  const bookingIds = [...new Set(invoices.map((i) => String(i.booking)).filter(Boolean))];
  const bookings = await VenueBooking.find({ _id: { $in: bookingIds } }).lean();
  const byId = new Map(bookings.map((b) => [String(b._id), b]));
  const buckets = {};
  const doubled = [];
  for (const inv of invoices) {
    const c = classify(inv, byId.get(String(inv.booking)));
    buckets[c.bucket] = (buckets[c.bucket] || 0) + 1;
    if (c.bucket === "DOUBLED" || c.bucket === "MISMATCH") doubled.push(c);
  }
  console.log(`milestone invoices scanned: ${invoices.length}`);
  console.log("buckets:", JSON.stringify(buckets));
  let over = 0;
  for (const d of doubled) {
    over += d.overBilledBy || d.delta || 0;
    console.log(` ${d.bucket}  ${d.inv}  booking ${d.booking}  ${d.couple || ""}  ${d.instalment || ""}  billed ${d.billed}  promised ${d.promised}  over ${d.overBilledBy !== undefined ? d.overBilledBy : d.delta}`);
  }
  console.log(`total over-billed across ${doubled.length} invoice(s): Rs. ${over.toLocaleString("en-IN")}`);
  await mongoose.disconnect();
})().catch((e) => { console.error("ASSESS FAILED:", e.message); process.exit(1); });
