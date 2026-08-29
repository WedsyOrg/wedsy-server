/**
 * utils/venueRecipients.js — who a venue email is addressed to by default.
 *
 * The People model has two flags that are NOT the same person: `isPrimary`
 * ("who you call") and `isDecisionMaker` ("who holds the money" — in Indian
 * weddings frequently the bride's father). Documents are about money, so the
 * decision maker is preselected. Ruled order:
 *
 *   1. a decision maker with an email (several → the first, rest listed)
 *   2. else the primary contact with an email
 *   3. else the first contact with an email
 *   4. else nobody — the screen focuses the free-entry field
 *
 * The sanitizer forces exactly one primary but leaves decision makers at zero
 * or many, so every branch is real.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const clean = (v) => String(v == null ? "" : v).trim();
const validEmail = (c) => c && EMAIL_RE.test(clean(c.email));

/** All email-bearing contacts, shaped for a picker, with the preselection made. */
function recipientOptions(lead) {
  const contacts = ((lead && lead.contacts) || []).filter(validEmail).map((c, i) => ({
    contactId: c._id ? String(c._id) : "",
    name: clean(c.name),
    email: clean(c.email).toLowerCase(),
    relation: c.relation || "other",
    isPrimary: Boolean(c.isPrimary),
    isDecisionMaker: Boolean(c.isDecisionMaker),
    order: i,
  }));
  const dm = contacts.find((c) => c.isDecisionMaker);
  const primary = contacts.find((c) => c.isPrimary);
  const chosen = dm || primary || contacts[0] || null;
  return {
    recipients: contacts.map((c) => ({ ...c, preselected: chosen ? c.email === chosen.email && c.order === chosen.order : false })),
    preselected: chosen ? chosen.email : "",
    reason: dm ? "decision_maker" : primary ? "primary" : chosen ? "first_with_email" : "none",
  };
}

/** Is this address already on the lead? (case-insensitive) */
function isOnLead(lead, email) {
  const e = clean(email).toLowerCase();
  return ((lead && lead.contacts) || []).some((c) => clean(c.email).toLowerCase() === e);
}

module.exports = { recipientOptions, isOnLead, EMAIL_RE };
