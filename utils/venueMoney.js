/**
 * utils/venueMoney.js — single source of truth for quote/invoice money math.
 *
 * Convention: discount reduces the taxable base; GST is charged on the
 * post-discount base. All amounts are integer rupees (Math.round).
 *
 *   subtotal   = Σ(qty × unitPrice)
 *   base       = max(0, subtotal − discount)
 *   gst        = round(base × gstPercent / 100)
 *   grandTotal = base + gst
 */
function computeTotals(lineItems, gstPercent = 18, discount = 0) {
  const items = Array.isArray(lineItems) ? lineItems : [];
  const subtotal = items.reduce((sum, li) => {
    const qty = Number(li && li.qty) || 0;
    const unit = Number(li && li.unitPrice) || 0;
    return sum + qty * unit;
  }, 0);
  const pct = Number(gstPercent) || 0;
  const disc = Number(discount) || 0;
  const base = Math.max(0, subtotal - disc);
  const gst = Math.round((base * pct) / 100);
  const grandTotal = base + gst;
  return {
    subtotal: Math.round(subtotal),
    gst,
    grandTotal,
  };
}

// Format integer rupees as "₹1,12,100" (Indian grouping).
function formatINR(amount) {
  const n = Math.round(Number(amount) || 0);
  return "₹" + n.toLocaleString("en-IN");
}

module.exports = { computeTotals, formatINR };
