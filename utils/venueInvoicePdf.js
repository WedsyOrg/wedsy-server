/**
 * utils/venueInvoicePdf.js — the invoice document, rendered from a booking and
 * (optionally) one recorded payment.
 *
 * Built from the SAME parts as every other venue document: venueHeader and
 * poweredByFooter from utils/venuePdf, branding resolved once by
 * utils/venueBranding, dates composed by utils/documentDate so prod and dev
 * cannot disagree, and the line-item table via utils/venueDocTable so the
 * header repeats across pages and no cell can silently truncate.
 *
 * Nothing is re-entered: every value here comes off the booking, the invoice
 * row, or venue Settings.
 */
const {
  bufferDoc,
  loadLogoBuffer,
  venueHeader,
  poweredByFooter,
  BURGUNDY,
  GREY,
} = require("./venuePdf");
const { resolveBranding } = require("./venueBranding");
const { docDayWithWeekday, docInstantDay } = require("./documentDate");
const { renderTable } = require("./venueDocTable");

const BODY = "#222222";
const TEXT_W = 495;

/** "Rs. 8,12,500" — Helvetica has no rupee glyph, same call the rest of the docs make. */
const money = (n) => `Rs. ${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;

/**
 * @param {object} args
 * @param {object} args.venue    selected with BRANDING_SELECT
 * @param {object} args.booking
 * @param {object} args.invoice  a persisted VenueInvoice
 * @param {object} [args.payment] the payment this invoice is raised against
 * @returns {Promise<Buffer>}
 */
async function buildInvoicePdf({ venue, booking, invoice, payment } = {}) {
  const brand = resolveBranding(venue || {});
  const inv = invoice || {};
  const bk = booking || {};
  const logoBuffer = await loadLogoBuffer(brand.logo);

  const { doc, done } = bufferDoc();
  venueHeader(doc, venue || {}, inv.gstMode === "none" ? "Invoice" : "Tax Invoice", logoBuffer);

  // ── the tax line, only when there is something to say ────────────────────
  // GST is optional per invoice. When it is off, the document must not imply a
  // tax invoice: no GSTIN line, and the title above says "Invoice".
  if (inv.gstMode !== "none" && brand.taxLine) {
    doc.fillColor(GREY).fontSize(9).text(brand.taxLine, 50, doc.y, { width: TEXT_W });
    doc.moveDown(0.4);
  } else if (inv.gstMode === "none" && brand.pan) {
    doc.fillColor(GREY).fontSize(9).text(`PAN: ${brand.pan}`, 50, doc.y, { width: TEXT_W });
    doc.moveDown(0.4);
  }

  // ── who and what ─────────────────────────────────────────────────────────
  const row = (label, value) => {
    if (!value) return; // absent → no row, no dangling label
    const y = doc.y;
    doc.fillColor(GREY).fontSize(9).text(label.toUpperCase(), 50, y, { width: 110 });
    doc.fillColor(BODY).fontSize(10).text(String(value), 165, y, { width: 380 });
    doc.moveDown(0.32);
  };

  // ── WHO IS BEING BILLED ──────────────────────────────────────────────────
  // From the invoice's frozen billedTo when it has one, falling back to the
  // booking for invoices raised before billing details existed. Reading the
  // lead's contacts live would let an already-issued invoice change.
  const billedTo = inv.billedTo || {};
  const clientGstin = String(billedTo.gstin || "").trim();

  row("Invoice no.", inv.invoiceNumber);
  row("Issued", docInstantDay(inv.createdAt || new Date()));
  row("Billed to", billedTo.name || bk.coupleName);
  row("Phone", billedTo.phone || bk.couplePhone);
  // THE CLIENT'S GSTIN — the B2B half of the document. Without it the
  // recipient cannot claim input tax credit on what they just paid, which is
  // the entire reason a company asks for a tax invoice rather than a receipt.
  // Labelled "Client GSTIN" and placed in the bill-to block, so it can never
  // be mistaken for the venue's own GSTIN printed up in the header.
  if (clientGstin) row("Client GSTIN", clientGstin);

  // Event dates with their weekdays — day keys, so formatted in UTC.
  const days = (bk.days || []).map((d) => d && d.date).filter(Boolean);
  if (days.length === 1) row("Event date", docDayWithWeekday(days[0]));
  else if (days.length > 1) {
    row("Event dates", docDayWithWeekday(days[0]));
    days.slice(1).forEach((d) => row("", docDayWithWeekday(d)));
  }
  const spaces = [...new Set((bk.days || []).flatMap((d) => (d && d.spaces) || []))].filter(Boolean);
  if (spaces.length) row("Spaces", spaces.join(", "));
  if (payment) {
    row("Against payment", `${money(payment.amount)}${payment.mode ? ` · ${payment.mode.replace(/_/g, " ")}` : ""}`);
    if (payment.reference) row("Reference", payment.reference);
  }

  doc.moveDown(0.5);

  // ── the line items ───────────────────────────────────────────────────────
  const items = Array.isArray(inv.lineItems) ? inv.lineItems : [];
  const stats = renderTable(doc, {
    header: [
      { text: "Item", backgroundColor: "#f6f4f7" },
      { text: "Qty", backgroundColor: "#f6f4f7" },
      { text: "Unit", backgroundColor: "#f6f4f7" },
      { text: "Amount", backgroundColor: "#f6f4f7" },
    ],
    rows: items.map((li) => [
      li.label || "—",
      String(Number(li.qty) || 0),
      money(li.unitPrice),
      money((Number(li.qty) || 0) * (Number(li.unitPrice) || 0)),
    ]),
    opts: { columnStyles: ["*", 50, 90, 100] },
  });

  // ── totals ───────────────────────────────────────────────────────────────
  const t = inv.totals || {};
  doc.moveDown(0.6);
  const right = (label, value, bold = false) => {
    const y = doc.y;
    doc.font(bold ? "Helvetica-Bold" : "Helvetica");
    doc.fillColor(bold ? BURGUNDY : GREY).fontSize(bold ? 12 : 10).text(label, 300, y, { width: 140, align: "right" });
    doc.fillColor(bold ? BURGUNDY : BODY).fontSize(bold ? 12 : 10).text(value, 450, y, { width: 95, align: "right" });
    doc.font("Helvetica");
    doc.moveDown(0.28);
  };
  right("Subtotal", money(t.subtotal));
  if (Number(inv.discount) > 0) right("Discount", `− ${money(inv.discount)}`);
  if (inv.gstMode === "none") {
    // Said out loud rather than left as an absence, so nobody reads a missing
    // GST line as an oversight.
    doc.fillColor(GREY).fontSize(9).text("GST not applicable on this invoice.", 300, doc.y, { width: 245, align: "right" });
    doc.moveDown(0.3);
  } else {
    right(`GST @ ${Number(inv.gstPercent) || 0}%${inv.gstMode === "inclusive" ? " (incl.)" : ""}`, money(t.gst));
  }
  right("Total", money(t.grandTotal), true);

  // ── balance, from the booking rather than recomputed here ────────────────
  if (Number.isFinite(Number(bk.totalValue)) && Number(bk.totalValue) > 0) {
    doc.moveDown(0.5).fillColor(GREY).fontSize(9);
    doc.text(`Booking value ${money(bk.totalValue)}.`, 50, doc.y, { width: TEXT_W });
  }

  poweredByFooter(doc, "", brand.whiteLabel);
  doc.end();
  const buffer = await done;
  return { buffer, tableStats: stats };
}

module.exports = { buildInvoicePdf, money };
