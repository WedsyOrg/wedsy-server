/**
 * utils/venueClientContact.js — the wizard's client step, folded into the ONE
 * contacts model.
 *
 * ── THE PROBLEM THIS SOLVES ─────────────────────────────────────────────────
 * The Confirm Booking wizard now captures the client's name, phone, email and
 * GSTIN. The obvious implementation is a `client` subdocument on the booking.
 * That would be wrong, and expensively so: the lead already has contacts[],
 * which the People tab owns and every other surface reads. A second store of
 * "who the client is" means two records that agree on the day the booking is
 * made and drift from then on — someone corrects a phone number in People, and
 * the invoice keeps quoting the old one forever with nothing to say which is
 * right.
 *
 * So the wizard does not get its own store. It performs an UPSERT into
 * contacts[], and everything downstream keeps reading the one list.
 *
 * ── HOW A CONTACT IS MATCHED ────────────────────────────────────────────────
 * In order, because each rung is weaker than the one above:
 *
 *   1. `contactId` — the owner explicitly picked someone from the People list.
 *      No guessing: that person is the client.
 *   2. PHONE — the closest thing to a natural key a contact has. Compared on
 *      digits only, so "+91 98765 43210" and "9876543210" are one person and
 *      not two.
 *   3. EMAIL, lowercased.
 *
 * Name is deliberately NOT a matching rung. Two "Sharma"s on one wedding lead
 * is ordinary, and silently merging them would corrupt the very list this
 * exists to protect. An entry that matches nothing is a NEW contact, which is
 * the honest outcome.
 *
 * ── WHAT AN UPSERT MAY OVERWRITE ────────────────────────────────────────────
 * Only fields the owner actually filled in. A blank email in the wizard means
 * "I didn't type one", never "delete the email People already has" — the
 * client step is a small form on the way to a booking, not an editor for the
 * whole contact record, and treating its blanks as deletions would quietly
 * strip data the People tab spent longer collecting.
 */

/**
 * The LAST TEN DIGITS, which is what actually identifies an Indian mobile.
 *
 * Digits-only alone is not enough and the first version of this was wrong
 * because of it: "+91 98765 00011" reduces to "919876500011" while the same
 * person stored from a webform is "9876500011". Those are not equal, so the
 * upsert created a duplicate contact — the precise failure this function
 * exists to prevent. Country codes and a leading 0 are both routinely typed,
 * and neither changes who is being called.
 *
 * Numbers shorter than ten digits are compared whole rather than padded, so a
 * partially-entered number cannot collide with a real one by suffix.
 */
const phoneKey = (s) => {
  const digits = String(s || "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
};
const emailKey = (s) => String(s || "").trim().toLowerCase();

/**
 * Merge the wizard's client into a contacts array.
 *
 * @param {Array} existing   enquiry.contacts (raw, as stored)
 * @param {object} client    { contactId?, name?, phone?, email?, relation?, gstin?, isDecisionMaker? }
 * @returns {{ contacts: Array, matchedBy: string, created: boolean, index: number }}
 *          `contacts` is the FULL new array, ready to hand to sanitizeContacts
 *          so the wizard's write goes through exactly the validation the
 *          People tab's write does.
 */
function mergeClientIntoContacts(existing, client) {
  const list = (Array.isArray(existing) ? existing : []).map((c) =>
    // Plain objects: these come back as mongoose subdocs and are about to be
    // handed to the sanitizer, which expects data rather than documents.
    (c && typeof c.toObject === "function" ? c.toObject() : { ...c })
  );
  const c = client || {};

  let index = -1;
  let matchedBy = "";

  if (c.contactId) {
    index = list.findIndex((x) => String(x._id || "") === String(c.contactId));
    if (index >= 0) matchedBy = "chosen";
  }
  if (index < 0 && phoneKey(c.phone)) {
    index = list.findIndex((x) => phoneKey(x.phone) && phoneKey(x.phone) === phoneKey(c.phone));
    if (index >= 0) matchedBy = "phone";
  }
  if (index < 0 && emailKey(c.email)) {
    index = list.findIndex((x) => emailKey(x.email) && emailKey(x.email) === emailKey(c.email));
    if (index >= 0) matchedBy = "email";
  }

  // Only what was actually typed. See the header on why blanks are not erasures.
  const filled = {};
  for (const key of ["name", "phone", "email", "relation", "gstin"]) {
    const v = c[key];
    if (v !== undefined && v !== null && String(v).trim() !== "") filled[key] = v;
  }
  if (c.isDecisionMaker !== undefined) filled.isDecisionMaker = Boolean(c.isDecisionMaker);

  const created = index < 0;
  if (created) {
    // Nothing to merge into and nothing to name them by — not a contact.
    if (!filled.name && !filled.phone) {
      return { contacts: list, matchedBy: "", created: false, index: -1 };
    }
    list.push({ ...filled });
    index = list.length - 1;
    matchedBy = "new";
  } else {
    list[index] = { ...list[index], ...filled };
  }

  // The client of the booking is who you call about the booking. sanitizeContacts
  // enforces exactly-one-primary; setting it here and clearing the others keeps
  // that decision explicit rather than leaving the sanitizer to pick by position.
  list.forEach((x, i) => { x.isPrimary = i === index; });

  return { contacts: list, matchedBy, created, index };
}

module.exports = { mergeClientIntoContacts, phoneKey, emailKey };
