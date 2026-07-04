// Slice B5b — AGREEMENT + INVOICE PDFs. pdfkit (already a repo dependency —
// utils/venuePdf.js precedent; pure JS, no chromium — t3.micro-safe). Clean
// text-and-rule branding; visual polish comes later. compress:false keeps the
// text streams greppable (tests assert on buffer content).
const PDFDocument = require("pdfkit");
const Setting = require("../models/Setting");
const Enquiry = require("../models/Enquiry");
const LeadPayment = require("../models/LeadPayment");
const Admin = require("../models/Admin");
const SettingsService = require("./SettingsService");

const err = (status, message) => Object.assign(new Error(message), { status });

// Helvetica has no ₹ glyph — rupee amounts render as "Rs. 1,23,456".
const money = (n) => `Rs. ${Number(n || 0).toLocaleString("en-IN")}`;
const day = (d = new Date()) =>
  new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });

const coupleOf = (lead) => {
  const q = lead.qualificationData || {};
  return q.groomName && q.brideName ? `${q.groomName} & ${q.brideName}` : lead.name || "The couple";
};
const eventDatesOf = (lead) => {
  const q = lead.qualificationData || {};
  const dates = (q.eventDays || [])
    .filter((d) => !d.dateUnknown && d.date)
    .map((d) => day(`${d.date}T00:00:00`));
  if (dates.length) return dates.join(", ");
  return q.eventDate ? day(`${q.eventDate}T00:00:00`) : "to be finalised";
};
const venueOf = (lead) => {
  const q = lead.qualificationData || {};
  return q.venueName || q.venueArea || "to be finalised";
};

// {tag} substitution over the settings template.
const mergeAgreement = (template, lead) =>
  String(template)
    .replaceAll("{couple}", coupleOf(lead))
    .replaceAll("{eventDates}", eventDatesOf(lead))
    .replaceAll("{venue}", venueOf(lead))
    .replaceAll("{amount}", lead.dealTotal != null ? money(lead.dealTotal) : "as agreed")
    .replaceAll("{today}", day());

const bufferFrom = (build) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 54, compress: false });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    build(doc);
    doc.end();
  });

const header = (doc, legalName, subtitle) => {
  doc.fontSize(22).font("Helvetica-Bold").text("WEDSY", { characterSpacing: 4 });
  doc.moveDown(0.2);
  doc.fontSize(9).font("Helvetica").fillColor("#555").text(legalName);
  doc.moveDown(0.6);
  doc.fillColor("#000").fontSize(13).font("Helvetica-Bold").text(subtitle);
  doc.moveDown(0.4);
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke("#999");
  doc.moveDown(1);
};

// ── Agreement ────────────────────────────────────────────────────────────────
const agreementPdf = async (leadId) => {
  const lead = await Enquiry.findById(leadId).lean();
  if (!lead) throw err(404, "Enquiry not found");
  const cfg = await SettingsService.getMany(["billing.agreementContent", "billing.companyLegalName", "billing.companyAddress"]);
  const body = mergeAgreement(cfg["billing.agreementContent"], lead);
  return bufferFrom((doc) => {
    header(doc, cfg["billing.companyLegalName"], "Service Agreement");
    if (cfg["billing.companyAddress"]) {
      doc.fontSize(9).fillColor("#555").text(cfg["billing.companyAddress"]);
      doc.moveDown(0.8);
    }
    doc.fillColor("#000").fontSize(11).font("Helvetica").text(body, { lineGap: 4 });
    doc.moveDown(2);
    doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.margins.left + 180, doc.y).stroke("#999");
    doc.fontSize(9).fillColor("#555").text("For Wedsy");
    doc.moveDown(1.4);
    doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.margins.left + 180, doc.y).stroke("#999");
    doc.text(coupleOf(lead));
  });
};

// ── Invoice numbering — atomic against the Setting doc, assigned ONCE ────────
const nextInvoiceNumber = async () => {
  const K = "billing.invoiceNextNumber";
  await Setting.updateOne(
    { key: K },
    { $setOnInsert: { value: SettingsService.DEFAULTS[K] } },
    { upsert: true }
  );
  // $inc is atomic; `new:false` returns the CONSUMED number. The raw write
  // bypasses SettingsService's 60s cache — invalidate so reads see the bump.
  const doc = await Setting.findOneAndUpdate({ key: K }, { $inc: { value: 1 } }, { new: false }).lean();
  SettingsService.invalidate();
  return Number(doc.value);
};

// Assign-once: only a GST invoice consumes a number; the filter re-checks the
// empty field so concurrent generations can't double-assign.
const ensureInvoiceNumber = async (payment) => {
  if (payment.invoiceNumber) return payment.invoiceNumber;
  const prefix = await SettingsService.get("billing.invoicePrefix");
  const n = await nextInvoiceNumber();
  const num = `${prefix}${String(n).padStart(4, "0")}`;
  const updated = await LeadPayment.findOneAndUpdate(
    { _id: payment._id, invoiceNumber: "" },
    { $set: { invoiceNumber: num } },
    { new: true }
  ).lean();
  // Raced by a concurrent generation → keep THEIR number (ours burns unused).
  return updated ? updated.invoiceNumber : (await LeadPayment.findById(payment._id).lean()).invoiceNumber;
};

// ── Invoice / receipt ────────────────────────────────────────────────────────
const invoicePdf = async (leadId, paymentId, { type = "simple" } = {}) => {
  if (!["simple", "gst"].includes(type)) throw err(400, "type must be 'simple' or 'gst'");
  const payment = await LeadPayment.findOne({ _id: paymentId, leadId }).lean();
  if (!payment) throw err(404, "Payment not found");
  const lead = await Enquiry.findById(leadId).lean();
  if (!lead) throw err(404, "Enquiry not found");
  const cfg = await SettingsService.getMany([
    "billing.companyLegalName", "billing.companyAddress", "billing.gstin", "billing.defaultTaxRate",
  ]);
  const recordedBy = payment.recordedBy ? await Admin.findById(payment.recordedBy, { name: 1 }).lean() : null;
  const invoiceNumber = type === "gst" ? await ensureInvoiceNumber(payment) : payment.invoiceNumber || "";

  return {
    buffer: await bufferFrom((doc) => {
      header(doc, cfg["billing.companyLegalName"], type === "gst" ? "Tax Invoice" : "Payment Receipt");

      if (type === "gst") {
        doc.fontSize(9).fillColor("#555");
        if (cfg["billing.companyAddress"]) doc.text(cfg["billing.companyAddress"]);
        if (cfg["billing.gstin"]) doc.text(`GSTIN: ${cfg["billing.gstin"]}`);
        doc.text(`Invoice No: ${invoiceNumber}`);
        doc.moveDown(0.8);
      }

      doc.fillColor("#000").fontSize(11).font("Helvetica");
      const rows = [
        ["Client", coupleOf(lead)],
        ["Date", day(payment.receivedAt)],
        ["Amount received", money(payment.amount)],
        ["Mode", String(payment.mode || "").toUpperCase()],
        ["Recorded by", recordedBy ? recordedBy.name : "—"],
      ];
      if (payment.note) rows.push(["Note", payment.note]);
      for (const [k, v] of rows) {
        doc.font("Helvetica-Bold").text(`${k}: `, { continued: true }).font("Helvetica").text(String(v));
        doc.moveDown(0.25);
      }

      if (type === "gst") {
        // The recorded amount is GST-INCLUSIVE: back out the taxable value.
        const rate = Number(cfg["billing.defaultTaxRate"]) || 0;
        const base = rate > 0 ? payment.amount / (1 + rate / 100) : payment.amount;
        const tax = payment.amount - base;
        doc.moveDown(0.8);
        doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke("#ccc");
        doc.moveDown(0.5);
        doc.font("Helvetica-Bold").text("Tax breakup", { underline: false });
        doc.moveDown(0.25);
        doc.font("Helvetica").text(`Taxable value: ${money(Math.round(base * 100) / 100)}`);
        doc.text(`GST @ ${rate}% (included): ${money(Math.round(tax * 100) / 100)}`);
        doc.font("Helvetica-Bold").text(`Total (inclusive): ${money(payment.amount)}`);
      }

      doc.moveDown(1.4);
      doc.fontSize(8.5).fillColor("#777").text("System-generated by Wedsy OS — no signature required.");
    }),
    invoiceNumber,
  };
};

module.exports = { agreementPdf, invoicePdf, mergeAgreement, ensureInvoiceNumber };
