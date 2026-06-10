/**
 * utils/venuePdf.js — branded PDF generation (pdfkit) for quotes and invoices.
 * Each function streams directly to the Express response.
 */
const PDFDocument = require("pdfkit");
const { formatINR } = require("./venueMoney");

const BURGUNDY = "#6b1e2e";
const GOLD = "#c9a961";
const GREY = "#555555";

function startDoc(res, filename) {
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  doc.pipe(res);
  return doc;
}

function venueHeader(doc, venue, titleText) {
  doc.fillColor(BURGUNDY).fontSize(22).text(venue.name || "Venue", { continued: false });
  const contact = venue.contact || {};
  const lines = [
    venue.address || venue.formattedAddress || "",
    contact.primaryPhone || venue.phone || "",
    contact.email || venue.email || "",
  ].filter(Boolean);
  doc.moveDown(0.2).fillColor(GREY).fontSize(9).text(lines.join("  •  "));
  doc.moveDown(0.6);
  doc.fillColor(GOLD).fontSize(16).text(titleText);
  doc.moveTo(50, doc.y + 4).lineTo(545, doc.y + 4).strokeColor(GOLD).stroke();
  doc.moveDown(0.8);
}

function lineItemsTable(doc, lineItems) {
  doc.fillColor(BURGUNDY).fontSize(10);
  const top = doc.y;
  doc.text("Item", 50, top);
  doc.text("Day", 280, top, { width: 40, align: "right" });
  doc.text("Qty", 330, top, { width: 40, align: "right" });
  doc.text("Unit", 380, top, { width: 75, align: "right" });
  doc.text("Amount", 460, top, { width: 85, align: "right" });
  doc.moveTo(50, doc.y + 2).lineTo(545, doc.y + 2).strokeColor("#dddddd").stroke();
  doc.moveDown(0.4);
  doc.fillColor("#222222").fontSize(10);
  (lineItems || []).forEach((li) => {
    const y = doc.y;
    const qty = Number(li.qty) || 0;
    const unit = Number(li.unitPrice) || 0;
    const label = li.perDay && li.day ? `${li.label} (per day)` : li.label;
    doc.text(String(label || "—"), 50, y, { width: 220 });
    doc.text(li.day != null ? String(li.day) : "—", 280, y, { width: 40, align: "right" });
    doc.text(String(qty), 330, y, { width: 40, align: "right" });
    doc.text(formatINR(unit), 380, y, { width: 75, align: "right" });
    doc.text(formatINR(qty * unit), 460, y, { width: 85, align: "right" });
    doc.moveDown(0.3);
  });
  doc.moveTo(50, doc.y + 2).lineTo(545, doc.y + 2).strokeColor("#dddddd").stroke();
  doc.moveDown(0.5);
}

function totalsBlock(doc, totals, gstPercent, discount) {
  const right = (label, value, opts = {}) => {
    const y = doc.y;
    doc.fillColor(opts.bold ? BURGUNDY : GREY).fontSize(opts.bold ? 12 : 10);
    doc.text(label, 330, y, { width: 110, align: "right" });
    doc.text(value, 450, y, { width: 95, align: "right" });
    doc.moveDown(0.3);
  };
  right("Subtotal", formatINR(totals.subtotal));
  if (discount) right("Discount", "− " + formatINR(discount));
  right(`GST (${gstPercent}%)`, formatINR(totals.gst));
  doc.moveDown(0.1);
  right("Grand Total", formatINR(totals.grandTotal), { bold: true });
}

// Quote PDF.
function streamQuotePdf(res, { venue, enquiry, quote }) {
  const doc = startDoc(res, `quote-${quote.version || 1}.pdf`);
  venueHeader(doc, venue, `Quotation  ·  v${quote.version || 1}`);
  doc.fillColor(GREY).fontSize(10);
  doc.text(`For: ${(enquiry && (enquiry.coupleName || enquiry.name)) || "—"}`);
  if (enquiry && enquiry.couplePhone) doc.text(`Phone: ${enquiry.couplePhone}`);
  doc.text(`Status: ${quote.status || "draft"}`);
  doc.moveDown(0.8);
  lineItemsTable(doc, quote.lineItems);
  totalsBlock(doc, quote.totals || {}, quote.gstPercent, quote.discount);
  doc.moveDown(2).fillColor(GREY).fontSize(8).text("This is a system-generated quotation.", 50, doc.y, { align: "center", width: 495 });
  doc.end();
}

// Invoice PDF (GST format).
function streamInvoicePdf(res, { venue, booking, invoice }) {
  const doc = startDoc(res, `${invoice.invoiceNumber}.pdf`);
  venueHeader(doc, venue, `Tax Invoice  ·  ${invoice.invoiceNumber}`);
  doc.fillColor(GREY).fontSize(10);
  const taxLines = [];
  if (venue.gstin) taxLines.push(`GSTIN: ${venue.gstin}`);
  if (venue.pan) taxLines.push(`PAN: ${venue.pan}`);
  if (taxLines.length) doc.text(taxLines.join("   "));
  doc.text(`Invoice No: ${invoice.invoiceNumber}    Kind: ${invoice.kind}`);
  if (booking && booking.coupleName) doc.text(`Billed to: ${booking.coupleName}${booking.couplePhone ? "  ·  " + booking.couplePhone : ""}`);
  doc.text(`Payment status: ${invoice.status}`);
  doc.moveDown(0.8);
  lineItemsTable(doc, invoice.lineItems);
  totalsBlock(doc, invoice.totals || {}, invoice.gstPercent, invoice.discount);

  const paid = (invoice.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const balance = (invoice.totals ? invoice.totals.grandTotal : 0) - paid;
  doc.moveDown(0.5).fillColor(GREY).fontSize(10);
  doc.text(`Received: ${formatINR(paid)}`, 330, doc.y, { width: 110, align: "right" });
  doc.text(formatINR(paid), 450, doc.y - 12, { width: 95, align: "right" });
  doc.text(`Balance: ${formatINR(balance)}`, 330, doc.y, { width: 110, align: "right" });
  doc.text(formatINR(balance), 450, doc.y - 12, { width: 95, align: "right" });
  doc.moveDown(2).fillColor(GREY).fontSize(8).text("This is a system-generated tax invoice.", 50, doc.y, { align: "center", width: 495 });
  doc.end();
}

module.exports = { streamQuotePdf, streamInvoicePdf };
