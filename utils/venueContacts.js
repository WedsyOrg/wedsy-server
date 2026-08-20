/**
 * utils/venueContacts.js — what a contact is, defined once.
 *
 * ── WHY THIS MOVED OUT OF THE CONTROLLER ────────────────────────────────────
 * sanitizeContacts lived in controllers/venueEnquiry. When the Confirm Booking
 * wizard began writing its client step into the SAME contacts[] array, the
 * booking controller needed the same validation — and requiring it created a
 * genuine cycle, because venueEnquiry already requires venueBooking for
 * createDraftBookingForEnquiry. Node resolved it by handing one side an
 * `undefined` import:
 *
 *     Warning: Accessing non-existent property 'createDraftBookingForEnquiry'
 *     of module exports inside circular dependency
 *
 * A lazy require inside the function would have silenced that, and would have
 * left two controllers importing each other for the next person to trip over.
 * Shared validation is not controller work; it belongs beside the other
 * venue input utils, where both callers can reach it and neither owns it.
 *
 * The rules themselves are unchanged: name-or-phone required per row, relation
 * coerced to the type's vocabulary rather than rejected, EXACTLY one isPrimary
 * in the result (first explicitly marked wins, else the first contact), and an
 * empty array allowed for legacy rows.
 */
const { cleanStr, MAXLEN } = require("./venueInput");
const { cleanEventType, relationAllowed } = require("./venueEventType");
const { normaliseGstin } = require("./venueGstin");

const MAX_CONTACTS = 20;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function sanitizeContacts(list, eventType) {
  if (!Array.isArray(list)) return { ok: false, message: "contacts must be an array" };
  if (list.length > MAX_CONTACTS) return { ok: false, message: `contacts is too long (max ${MAX_CONTACTS})` };
  const type = cleanEventType(eventType);
  const out = [];
  // Non-blocking notes handed back to the caller — see utils/venueGstin on why
  // a doubtful check digit must not refuse the save.
  const warnings = [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i] || {};
    const name = cleanStr(c.name).slice(0, MAXLEN.name);
    const phone = cleanStr(c.phone).slice(0, MAXLEN.phone);
    if (!name && !phone) return { ok: false, message: `contacts[${i}] needs a name or phone` };
    const email = cleanStr(c.email).slice(0, MAXLEN.name).toLowerCase();
    if (email && !EMAIL_RE.test(email)) {
      return { ok: false, message: `contacts[${i}].email is not a valid email address` };
    }
    // `relation` is the field; `role` is accepted as the legacy input name so a
    // client mid-deploy keeps working. Unknown values coerce to "other" rather
    // than 400 — the vocabulary is type-dependent and a lead that just switched
    // type would otherwise be unsaveable until every row was re-picked.
    const incoming = c.relation !== undefined ? c.relation : c.role;
    const relation = relationAllowed(type, incoming) ? incoming : "other";
    // The client's GSTIN rides the same sanitizer as everything else on a
    // contact, so the wizard's client step and the People tab cannot end up
    // normalising it differently.
    const gst = normaliseGstin(c.gstin);
    if (!gst.ok) return { ok: false, message: `contacts[${i}].gstin — ${gst.message}` };
    if (gst.warning) warnings.push(`${name || phone || `contacts[${i}]`}: ${gst.warning}`);
    // Subdocument ids are preserved when the caller passes them back, so an
    // upsert against an existing contact updates that row rather than replacing
    // the array with fresh ids and orphaning anything that referenced them.
    const row = {
      name,
      phone,
      email,
      relation,
      // Legacy mirror, written never read — see the model.
      role: relation,
      isPrimary: Boolean(c.isPrimary),
      isDecisionMaker: Boolean(c.isDecisionMaker),
      gstin: gst.value,
    };
    if (c._id) row._id = c._id;
    out.push(row);
  }
  if (out.length > 0) {
    const primaryIdx = out.findIndex((c) => c.isPrimary);
    out.forEach((c, i) => { c.isPrimary = i === (primaryIdx === -1 ? 0 : primaryIdx); });
    // Decision maker is NOT forced to exist and NOT forced to be unique-or-first
    // the way primary is: "we don't know yet" is a real answer, and two parents
    // sharing the cheque is a real arrangement. Only the "exactly one person to
    // call" rule is a genuine invariant.
  }
  return { ok: true, value: out, warnings };
}

module.exports = { sanitizeContacts, MAX_CONTACTS, EMAIL_RE };
