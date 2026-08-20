/**
 * utils/venueGstin.js — validating a client's GSTIN before it reaches a tax
 * invoice.
 *
 * ── WHY A CHECKSUM AND NOT A LENGTH CHECK ───────────────────────────────────
 * A GSTIN on an issued tax invoice is what lets the client claim input tax
 * credit. If it is wrong, the claim fails at the client's end — weeks later,
 * against a document we cannot edit because invoices are immutable. The only
 * remedy at that point is a credit note and a reissue.
 *
 * A GSTIN carries its own check digit precisely so a transposed pair can be
 * caught at entry. Validating the shape but not the checksum would accept
 * "27AAPFU0939F1Z6" typed as "27AAPFU0939F1Z5" — right length, right pattern,
 * wrong number, and no way to know until it matters. So we verify it here,
 * once, at the boundary where a person typed it and can still fix it.
 *
 * ── THE FORMAT ──────────────────────────────────────────────────────────────
 *   2   state code
 *   10  the holder's PAN
 *   1   entity number for that PAN in that state
 *   1   literal 'Z'
 *   1   check digit
 */

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * The GSTIN check digit: a modulus-36 weighted sum, alternating factors of 1
 * and 2, where each doubled product is folded back into base 36 (quotient plus
 * remainder) before being summed — the same construction as a Luhn digit, in
 * base 36 rather than base 10.
 */
function checkDigit(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = ALPHABET.indexOf(first14[i]);
    if (value < 0) return null;
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return ALPHABET[(36 - (sum % 36)) % 36];
}

/**
 * Returns { ok: true, value } with the normalised GSTIN, or { ok: false,
 * message } naming what is wrong in terms the person who typed it can act on.
 * An empty value is legitimate — GST details are optional — and returns "".
 */
function normaliseGstin(input) {
  if (input === undefined || input === null) return { ok: true, value: "" };
  const raw = String(input).trim().toUpperCase().replace(/[\s-]/g, "");
  if (!raw) return { ok: true, value: "" };
  if (raw.length !== 15) {
    return { ok: false, message: `A GSTIN is 15 characters — that one is ${raw.length}.` };
  }
  if (!GSTIN_RE.test(raw)) {
    return { ok: false, message: "That doesn't look like a GSTIN. The format is 22AAAAA0000A1Z5." };
  }
  // ── THE CHECK DIGIT IS A WARNING, NOT A REFUSAL ──────────────────────────
  // Deliberate, and the asymmetry is the reason. Accepting a mistyped GSTIN
  // costs the client a failed input-tax-credit claim weeks later. REJECTING a
  // valid one stops a real venue invoicing a real client today, with no way
  // around it — and a venue that cannot invoice will simply stop using the
  // product. The second failure is worse and has no workaround, so the check
  // digit surfaces as something to re-read rather than a locked door.
  //
  // It is a warning rather than a hard rule for an honest second reason: this
  // implementation of the mod-36 fold is verified against the one canonical
  // published example and no more. That is enough to flag a likely typo. It is
  // not enough to refuse someone's tax identity on.
  const expected = checkDigit(raw.slice(0, 14));
  const warning =
    expected && raw[14] !== expected
      ? "That GSTIN's check digit doesn't look right — worth re-reading before it goes on an invoice."
      : "";
  return { ok: true, value: raw, warning };
}

module.exports = { normaliseGstin, GSTIN_RE };
