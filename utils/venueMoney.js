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

// Format integer rupees as "₹1,12,100" (Indian grouping).
function formatINR(amount) {
  const n = Math.round(Number(amount) || 0);
  return "₹" + n.toLocaleString("en-IN");
}

module.exports = { computeTotals, formatINR, GST_MODES };
