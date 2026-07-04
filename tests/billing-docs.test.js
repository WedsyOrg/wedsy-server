/**
 * Agreement & billing settings + PDFs — Slice B5b.
 *
 *   node tests/billing-docs.test.js
 *
 * PDFs are generated with compress:false, so the buffer's text streams are
 * directly greppable.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Department = require("../models/Department");
const LeadPayment = require("../models/LeadPayment");
const Setting = require("../models/Setting");
const SettingsService = require("../services/SettingsService");
const BillingDocService = require("../services/BillingDocService");

const TAG = `billing-${Date.now()}`;

// pdfkit writes text as hex strings (<48656c...>) — decode them all so the
// assertions can grep the document's actual text.
const pdfText = (buf) =>
  (buf.toString("latin1").match(/<([0-9a-fA-F]+)>/g) || [])
    .map((h) => Buffer.from(h.slice(1, -1), "hex").toString("latin1"))
    .join("");
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

  const leadIds = [], adminIds = [];
  let dept = null;
  const snapshots = {};
  for (const k of ["billing.invoiceNextNumber", "billing.invoicePrefix", "billing.gstin", "billing.companyLegalName", "billing.defaultTaxRate"]) {
    snapshots[k] = await SettingsService.get(k);
  }
  try {
    dept = await Department.create({ name: `${TAG}-dept` });
    const owner = await Admin.create({ name: `${TAG}-owner`, email: `${TAG}@x.com`, phone: `${TAG}a`, password: "x", status: "active", departmentId: dept._id });
    adminIds.push(owner._id);

    const lead = await Enquiry.create({
      name: "Billing Lead", phone: `${TAG}`, verified: false, isInterested: false, isLost: false,
      stage: "won", source: "Default", assignedTo: owner._id, qualified: true, qualifiedAt: new Date(),
      dealTotal: 1225000,
      qualificationData: {
        groomName: "Karthik", brideName: "Ananya", venueName: "Taj West End",
        eventDays: [{ date: "2026-12-11", functions: [{ type: "Mehendi" }] }, { date: "2026-12-12", functions: [{ type: "Wedding" }] }],
      },
    });
    leadIds.push(lead._id);

    // Deterministic billing settings for the assertions.
    await SettingsService.set("billing.invoicePrefix", "WD-");
    await SettingsService.set("billing.invoiceNextNumber", 101);
    await SettingsService.set("billing.gstin", "29ABCDE1234F1Z5");
    await SettingsService.set("billing.companyLegalName", "Wedsy Weddings Pvt Ltd");
    await SettingsService.set("billing.defaultTaxRate", 18);

    // ── 1. Merge tags.
    console.log("1. agreement merge tags");
    const merged = BillingDocService.mergeAgreement(
      "A: {couple} | D: {eventDates} | V: {venue} | Amt: {amount} | T: {today}",
      lead.toObject()
    );
    ok(merged.includes("Karthik & Ananya"), "{couple} merged");
    ok(merged.includes("11 December 2026") && merged.includes("12 December 2026"), "{eventDates} merged (both days)");
    ok(merged.includes("Taj West End"), "{venue} merged");
    ok(merged.includes("Rs. 12,25,000"), "{amount} merged from dealTotal");
    ok(!/\{[a-zA-Z]+\}/.test(merged), "no unresolved {tags} remain");

    const agrBuf = await BillingDocService.agreementPdf(lead._id);
    const agrTxt = pdfText(agrBuf);
    ok(agrBuf.subarray(0, 5).toString() === "%PDF-", "agreement is a real PDF");
    ok(agrTxt.includes("Karthik & Ananya") && agrTxt.includes("Service Agreement"), "agreement PDF carries the merged content");

    // ── 2. Invoice numbering — assigned once, sticks, increments the counter.
    console.log("2. invoice numbering");
    const payment = await LeadPayment.create({ leadId: lead._id, amount: 25000, mode: "razorpay", recordedBy: owner._id, receivedAt: new Date() });
    const gst1 = await BillingDocService.invoicePdf(lead._id, payment._id, { type: "gst" });
    ok(gst1.invoiceNumber === "WD-0101", `first GST generation assigns WD-0101 (got ${gst1.invoiceNumber})`);
    const gst2 = await BillingDocService.invoicePdf(lead._id, payment._id, { type: "gst" });
    ok(gst2.invoiceNumber === "WD-0101", "second generation KEEPS the same number");
    ok((await SettingsService.get("billing.invoiceNextNumber")) === 102, "counter incremented exactly once");
    const payment2 = await LeadPayment.create({ leadId: lead._id, amount: 480000, mode: "upi", recordedBy: owner._id, receivedAt: new Date() });
    const gst3 = await BillingDocService.invoicePdf(lead._id, payment2._id, { type: "gst" });
    ok(gst3.invoiceNumber === "WD-0102", "next payment takes the next number");

    // ── 3. gst vs simple content.
    console.log("3. gst vs simple");
    const gstTxt = pdfText(gst1.buffer);
    ok(gstTxt.includes("Tax Invoice") && gstTxt.includes("29ABCDE1234F1Z5") && gstTxt.includes("WD-0101"), "gst: legal chrome + GSTIN + number");
    ok(gstTxt.includes("GST @ 18%") && gstTxt.includes("Taxable value"), "gst: inclusive tax breakup");
    const simple = await BillingDocService.invoicePdf(lead._id, payment._id, { type: "simple" });
    const simpleTxt = pdfText(simple.buffer);
    ok(simpleTxt.includes("Payment Receipt") && !simpleTxt.includes("GSTIN") && !simpleTxt.includes("Taxable value"), "simple: branded receipt, no tax chrome");
    ok(simpleTxt.includes("Karthik & Ananya") && simpleTxt.includes("RAZORPAY") && simpleTxt.includes(`${TAG}-owner`), "simple: couple + mode + recordedBy");

    // ── 4. Settings CRUD + gating vocabulary.
    console.log("4. settings");
    let bad = null;
    try { await SettingsService.set("billing.defaultTaxRate", 99); } catch (e) { bad = e.status; }
    ok(bad === 400, "invalid tax rate rejected");
    bad = null;
    try { await SettingsService.set("billing.invoicePrefix", ""); } catch (e) { bad = e.status; }
    ok(bad === 400, "empty invoice prefix rejected");
    ok(SettingsService.categoryForKey("billing.agreementContent") === "settings_billing", "billing keys gate on settings_billing");
    ok(SettingsService.categoryForKey("broadcast.winAudience") === "settings_billing", "winAudience rides the billing category");
    const cat = await SettingsService.getCategory("settings_billing");
    ok("billing.agreementContent" in cat && "billing.invoiceNextNumber" in cat, "GET /settings/billing category resolves all keys");
  } finally {
    if (leadIds.length) {
      await LeadPayment.deleteMany({ leadId: { $in: leadIds } });
      await Enquiry.deleteMany({ _id: { $in: leadIds } });
    }
    if (adminIds.length) await Admin.deleteMany({ _id: { $in: adminIds } });
    if (dept) await Department.deleteMany({ _id: dept._id });
    for (const [k, v] of Object.entries(snapshots)) await SettingsService.set(k, v);
    await mongoose.disconnect();
  }

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("Test harness error:", e); process.exit(1); });
