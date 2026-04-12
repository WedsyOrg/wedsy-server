/**
 * Normalize vendor BiddingOffer payloads: `content` is the amount due now
 * (sum of unpaid eventPricing rows). Keeps eventPricing rows stable.
 */
function normalizeBiddingOfferPayload({ content, other = {} }) {
  const ep = other.eventPricing;
  if (!Array.isArray(ep) || ep.length === 0) {
    return { content: String(content ?? ""), other };
  }
  const eventPricing = ep.map((e) => {
    const row = {
      eventName: String(e.eventName || "").trim(),
      amount: Number(e.amount) || 0,
      paid: Boolean(e.paid),
    };
    if (e.orderId != null && String(e.orderId).length) {
      row.orderId = String(e.orderId);
    }
    return row;
  });
  const unpaidSum = eventPricing
    .filter((e) => !e.paid)
    .reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const totalSum = eventPricing.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const due = unpaidSum > 0 ? unpaidSum : totalSum;
  return {
    content: String(due),
    other: { ...other, eventPricing },
  };
}

module.exports = { normalizeBiddingOfferPayload };
