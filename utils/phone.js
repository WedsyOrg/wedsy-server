/* PHONE NORMALISATION — the ONE implementation.
 *
 * This is not only a Conversions API concern. The same digits build wa.me
 * links, so a wrongly-derived country code does not merely mis-hash an
 * identifier — it opens a WhatsApp conversation with a DIFFERENT PERSON. That
 * is the failure this file exists to prevent, and it is why the rules below
 * refuse to guess in every case except one, and confess loudly in that one.
 *
 * THE RULES
 *   1. Already carries a country code — starts with "+", or is longer than ten
 *      digits — USE IT AS IS. Never re-derive it, never prepend to it. A
 *      +971 number that comes back with a 91 on the front is a stranger's
 *      number, and nothing downstream can tell that it is wrong.
 *   2. Exactly ten digits and no "+" — apply DEFAULT_COUNTRY_CODE and LOG that
 *      a default was applied, with the lead id. This is the one guess in the
 *      file. The log is not decoration: it is how we find out how often we
 *      guess and whether we are wrong, and it is what makes the guess
 *      reversible instead of invisible.
 *   3. Fewer than ten digits, or an "ig:" placeholder — THERE IS NO PHONE.
 *      Do not hash it, do not build a link from it, do not pad it.
 *
 * THE LITERAL "91" APPEARS ONCE IN THIS REPO'S PRODUCTION PATH: as the fallback
 * for the env var, below. Anywhere else it is an assumption waiting to message
 * the wrong person.
 */

// Read at CALL time, never memoised at module load: a deploy that changes the
// env must not need a restart to take effect, and a caller must be able to
// prove the value is read rather than baked in.
const defaultCountryCode = () =>
  String(process.env.DEFAULT_COUNTRY_CODE || "91").replace(/[^0-9]/g, "") || "91";

// "ig:<sender id>" is services/InstagramAgentService.js's placeholder for a
// lead that has not shared a number yet. Stripping symbols and letters would
// turn it into a plausible-looking 14-digit "phone number", so it has to be
// rejected on the RAW value, before any normalisation touches it.
const isPlaceholder = (raw) => /^ig:/i.test(String(raw || "").trim());

/**
 * Normalise a stored phone to digits including a country code.
 *
 * @param   {string} raw            the stored value, in whatever shape
 * @param   {object} [opts]
 * @param   {string} [opts.leadId]  included in the "assumed a country code" log
 * @param   {string} [opts.context] which caller is asking (capi, wa-link, …)
 * @returns {string|null}           digits with a country code, or null
 */
const normalisePhone = (raw, { leadId = null, context = "" } = {}) => {
  const original = String(raw || "").trim();
  if (!original || isPlaceholder(original)) return null;

  const hadPlus = original.startsWith("+");
  // A leading zero is a national trunk prefix, not part of the number, and
  // Meta's own normalisation strips it. Stripping BEFORE the length test is
  // what stops "09876543210" reading as eleven digits — i.e. as though it
  // already carried a country code — and being sent with a bare 0 on the front.
  const digits = original.replace(/[^0-9]/g, "").replace(/^0+/, "");
  if (!digits) return null;

  // Rule 3 — too short to be a phone number. Do not pad, do not guess.
  if (digits.length < 10) return null;

  // Rule 1 — it already carries a country code. Untouched.
  if (hadPlus || digits.length > 10) return digits;

  // Rule 2 — exactly ten digits, no "+". THE ONE GUESS. Say so, every time.
  const cc = defaultCountryCode();
  console.log(
    `[phone] ASSUMED country code +${cc} for a 10-digit number` +
      `${leadId ? ` lead=${leadId}` : ""}${context ? ` context=${context}` : ""}` +
      ` — stored value carried none`
  );
  return `${cc}${digits}`;
};

module.exports = { normalisePhone, defaultCountryCode, isPlaceholder };
