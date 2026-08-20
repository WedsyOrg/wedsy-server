/**
 * utils/venueBilledTo.js — deciding WHICH contact an invoice is billed to.
 *
 * A lead can have several contacts: the couple, both sets of parents, a
 * wedding planner. Only one of them is the party being invoiced, and picking
 * the wrong one puts somebody else's name and tax number on a financial
 * document.
 *
 * The order below is not arbitrary — each rung is a stronger statement than
 * the one under it:
 *
 *   1. A contact with a GSTIN. Nobody enters a GSTIN by accident; it is only
 *      ever typed by the person arranging to be billed, and it is the whole
 *      reason B2B invoicing exists on this screen. If exactly one contact has
 *      one, that is the billing party regardless of any other flag.
 *   2. The DECISION MAKER. Explicitly "who holds the money" — in Indian
 *      weddings frequently the bride's father rather than either of the people
 *      getting married.
 *   3. The PRIMARY contact. "Who you call" is a weaker claim than "who pays",
 *      but it is a deliberate choice by the owner.
 *   4. The first contact, then the booking's own coupleName/couplePhone. The
 *      last of these is what every invoice used before any of this existed, so
 *      a lead with no contacts still bills exactly as it did.
 *
 * Ambiguity is not resolved silently: when more than one contact carries a
 * GSTIN we fall through to the decision-maker/primary rungs rather than
 * guessing which company is paying.
 */

function pickBillingContact(contacts) {
  const list = (Array.isArray(contacts) ? contacts : []).filter(Boolean);
  if (!list.length) return null;

  const withGstin = list.filter((c) => String(c.gstin || "").trim());
  // Exactly one — an unambiguous statement of who is being billed.
  if (withGstin.length === 1) return withGstin[0];
  // Several. Prefer a GSTIN-holder that is ALSO flagged as paying, before
  // giving up and using the ordinary rungs.
  if (withGstin.length > 1) {
    const decisive = withGstin.find((c) => c.isDecisionMaker) || withGstin.find((c) => c.isPrimary);
    if (decisive) return decisive;
  }

  return list.find((c) => c.isDecisionMaker) || list.find((c) => c.isPrimary) || list[0];
}

/**
 * The frozen bill-to block for a new invoice. Falls back to the booking so an
 * invoice always names somebody, exactly as it did before contacts carried
 * billing details.
 */
function billedToSnapshot(contacts, booking) {
  const c = pickBillingContact(contacts);
  const bk = booking || {};
  return {
    name: (c && c.name) || bk.coupleName || "",
    phone: (c && c.phone) || bk.couplePhone || "",
    email: (c && c.email) || "",
    gstin: (c && String(c.gstin || "").trim()) || "",
  };
}

module.exports = { pickBillingContact, billedToSnapshot };
