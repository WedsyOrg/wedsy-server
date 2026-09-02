/**
 * utils/venueMoney.js — single source of truth for quote/bill/invoice money math.
 *
 * Convention: discount reduces the base; all amounts integer rupees (Math.round).
 * D8 adds a per-document GST MODE (additive — default is the historical math):
 *
 *   exclusive (default) — entered prices EXCLUDE GST; it is added on top:
 *     base = max(0, subtotal − discount); gst = round(base × pct/100)
 *     taxable = base; grandTotal = base + gst
 *   inclusive — entered prices INCLUDE GST; it is back-computed:
 *     base = max(0, subtotal − discount); gst = round(base × pct/(100+pct))
 *     taxable = base − gst; grandTotal = base
 *   none — no GST on this document:
 *     gst = 0; taxable = base; grandTotal = base
 */
const GST_MODES = ["exclusive", "inclusive", "none"];

function computeTotals(lineItems, gstPercent = 18, discount = 0, gstMode = "exclusive") {
  const items = Array.isArray(lineItems) ? lineItems : [];
  const subtotal = items.reduce((sum, li) => {
    const qty = Number(li && li.qty) || 0;
    const unit = Number(li && li.unitPrice) || 0;
    return sum + qty * unit;
  }, 0);
  const pct = Number(gstPercent) || 0;
  const disc = Number(discount) || 0;
  const mode = GST_MODES.includes(gstMode) ? gstMode : "exclusive";
  const base = Math.max(0, Math.round(subtotal) - disc);

  let gst, taxable, grandTotal;
  if (mode === "none") {
    gst = 0;
    taxable = base;
    grandTotal = base;
  } else if (mode === "inclusive") {
    gst = Math.round((base * pct) / (100 + pct));
    taxable = base - gst;
    grandTotal = base;
  } else {
    gst = Math.round((base * pct) / 100);
    taxable = base;
    grandTotal = base + gst;
  }
  return {
    subtotal: Math.round(subtotal),
    taxable,
    gst,
    grandTotal,
  };
}

/**
 * ══ LINE-MODE TOTALS (money lines, Phase 1) ═════════════════════════════════
 * A line-mode quote is a set of lines each carrying its own GST TREATMENT and
 * REFUNDABLE flag; the single `gstPercent` is the one rate, applied per line
 * to whatever that line says is taxable:
 *
 *   none — taxable 0 · full — taxable = amount · part — taxable = taxableAmount
 *
 * GST rounds PER LINE (Math.round, same as gstOnRow) so a line's own
 * arithmetic is printable: 5,00,000 with GST on part 2,00,000 at 18% is
 * 36,000, and the line contributes 5,36,000 — a sentence, not a residue.
 *
 * ── CHARGED vs REFUNDABLE, the split this build exists for ─────────────────
 * `charged` is the revenue figure: the sum of NON-refundable line amounts,
 * GST-exclusive. `refundable` is held-and-returned money: inside the document
 * total, never revenue. `grandTotal` = everything + GST — what the document
 * shows on top. The seam (S3) writes `charged` into VenueBooking.totalValue,
 * which is how every scalar revenue consumer stays correct without changing.
 *
 * This does NOT replace computeTotals above: bills, invoices, templates and
 * legacy quotes keep document-mode math untouched. A quote is one or the
 * other, never both — the controller refuses a mixed payload.
 */
function lineTaxable(line) {
  const amount = Math.round(Number(line && line.amount) || 0);
  const t = String((line && line.gstTreatment) || "none");
  if (t === "full") return amount;
  if (t === "part") return Math.round(Number(line.taxableAmount) || 0);
  return 0;
}

function computeLineTotals(lineItems, gstPercent = 18) {
  const items = Array.isArray(lineItems) ? lineItems : [];
  const pct = Number(gstPercent) || 0;
  let subtotal = 0;
  let charged = 0;
  let refundable = 0;
  let taxable = 0;
  let gst = 0;
  for (const li of items) {
    const amount = Math.round(Number(li && li.amount) || 0);
    subtotal += amount;
    if (li && li.refundable) refundable += amount;
    else charged += amount;
    const t = lineTaxable(li);
    taxable += t;
    gst += Math.round((t * pct) / 100);
  }
  return { subtotal, charged, refundable, taxable, gst, grandTotal: subtotal + gst };
}

/**
 * ── THE TAX-INVOICE VIEW OF A SET OF LINES (money lines S5) ─────────────────
 * What an invoice raised from lines bills: the NON-REFUNDABLE lines, with GST
 * derived per line against the one rate and stored as finished totals —
 * computeTotals would apply one rate to the whole subtotal and over-tax any
 * line whose treatment is "part" or "none" (the same reasoning as the payment
 * invoice's per-row derivation in controllers/venueLeadInvoice).
 *
 * ── WHY THE HELD DEPOSIT IS NOT HERE ────────────────────────────────────────
 * A refundable line is money the venue HOLDS, not money it earns, and this
 * model already refuses to invoice held money: the room-stay deposit
 * (controllers/venueCheckin) is never invoiced — only its materialised
 * DEDUCTION becomes a real add-on invoice, at the moment damages make it
 * consideration. A tax invoice evidences a supply; a deposit held against one
 * is not that, and it becomes invoiceable only if it is ever applied — which
 * is a forfeiture flow this build does not have. The deposit lives on the
 * statement ("of which refundable, held") and in the schedule; it does not
 * live on a tax invoice.
 *
 * `gstMode` comes back "exclusive" when any line bears GST (grandTotal =
 * base + GST is that shape) and "none" otherwise, so the invoice PDF's
 * header ("Tax Invoice" vs "Invoice") and its GST block stay truthful.
 */
function invoiceViewOfLines(lines, gstPercent) {
  const billable = (Array.isArray(lines) ? lines : []).filter((li) => li && !li.refundable);
  const t = computeLineTotals(billable, gstPercent);
  return {
    hasBillable: billable.length > 0,
    bears: t.gst > 0,
    gstMode: t.gst > 0 ? "exclusive" : "none",
    gstPercent: Number(gstPercent) || 0,
    lineItems: billable.map((li) => ({
      label: li.label || "Charge",
      category: "venue",
      qty: 1,
      unitPrice: Math.round(Number(li.amount) || 0),
    })),
    totals: { subtotal: t.subtotal, taxable: t.taxable, gst: t.gst, grandTotal: t.grandTotal },
  };
}

/**
 * ── THE LINE-BOOKING SCHEDULE INVARIANT, IN ONE PLACE ───────────────────────
 * Σ non-additional schedule rows === charged + refundable (what the couple
 * pays for the AGREED deal; extras ride above it as isAdditional rows).
 * The PATCH-time guard, the post-booking line edit and the fold all enforce
 * this through THIS function — the standing rule about two implementations
 * of one fact.
 *
 * @returns {null | {scheduled:number, payable:number}} null when consistent.
 */
function scheduleMismatch(rows, lineFigures) {
  const payable = (Math.round(Number(lineFigures.charged)) || 0) + (Math.round(Number(lineFigures.refundable)) || 0);
  const scheduled = (rows || [])
    .filter((r) => !(r && r.isAdditional))
    .reduce((s, r) => s + (Math.round(Number(r && r.amount)) || 0), 0);
  return scheduled === payable ? null : { scheduled, payable };
}

// Format integer rupees as "₹1,12,100" (Indian grouping).
function formatINR(amount) {
  const n = Math.round(Number(amount) || 0);
  return "₹" + n.toLocaleString("en-IN");
}

module.exports = { computeTotals, computeLineTotals, lineTaxable, invoiceViewOfLines, formatINR, GST_MODES, scheduleMismatch };
