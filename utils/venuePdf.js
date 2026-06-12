/**
 * utils/venuePdf.js — branded PDF generation (pdfkit) for quotes and invoices.
 * Each function streams directly to the Express response.
 */
const PDFDocument = require("pdfkit");
const axios = require("axios");
const { formatINR } = require("./venueMoney");

const BURGUNDY = "#6b1e2e";
const GOLD = "#c9a961";
const GREY = "#555555";

/**
 * Resolve venue.logo into an image buffer pdfkit can embed (JPEG/PNG).
 * Supports data: URIs and http(s) URLs (uploads via /file/upload are
 * sharp-normalised JPEGs). Missing, unreachable or malformed logos resolve
 * to null and the PDF renders exactly as before — never an error.
 */
async function loadLogoBuffer(logo) {
  if (!logo || typeof logo !== "string") return null;
  try {
    if (logo.startsWith("data:image/")) {
      const b64 = logo.slice(logo.indexOf(",") + 1);
      const buf = Buffer.from(b64, "base64");
      return buf.length > 0 ? buf : null;
    }
    if (/^https?:\/\//.test(logo)) {
      const res = await axios.get(logo, { responseType: "arraybuffer", timeout: 4000 });
      const buf = Buffer.from(res.data);
      return buf.length > 0 ? buf : null;
    }
  } catch {
    /* graceful absence */
  }
  return null;
}

function startDoc(res, filename) {
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  doc.pipe(res);
  return doc;
}

function venueHeader(doc, venue, titleText, logoBuffer) {
  // Logo top-left when present; the venue text block shifts right beside it.
  let textX = 50;
  if (logoBuffer) {
    try {
      doc.image(logoBuffer, 50, 50, { fit: [110, 44] });
      textX = 175;
    } catch {
      textX = 50; // bytes pdfkit can't embed — render as if absent
    }
  }
  doc.fillColor(BURGUNDY).fontSize(22).text(venue.name || "Venue", textX, 50, { continued: false });
  const contact = venue.contact || {};
  const lines = [
    venue.address || venue.formattedAddress || "",
    contact.primaryPhone || venue.phone || "",
    contact.email || venue.email || "",
  ].filter(Boolean);
  doc.moveDown(0.2).fillColor(GREY).fontSize(9).text(lines.join("  •  "), textX, doc.y);
  // Keep the title row clear of the logo block however short the text is.
  if (logoBuffer && doc.y < 100) doc.y = 100;
  doc.moveDown(0.6);
  doc.fillColor(GOLD).fontSize(16).text(titleText, 50, doc.y);
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
async function streamQuotePdf(res, { venue, enquiry, quote }) {
  const logoBuffer = await loadLogoBuffer(venue.logo); // resolve before piping starts
  const doc = startDoc(res, `quote-${quote.version || 1}.pdf`);
  venueHeader(doc, venue, `Quotation  ·  v${quote.version || 1}`, logoBuffer);
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
async function streamInvoicePdf(res, { venue, booking, invoice }) {
  const logoBuffer = await loadLogoBuffer(venue.logo); // resolve before piping starts
  const doc = startDoc(res, `${invoice.invoiceNumber}.pdf`);
  venueHeader(doc, venue, `Tax Invoice  ·  ${invoice.invoiceNumber}`, logoBuffer);
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
