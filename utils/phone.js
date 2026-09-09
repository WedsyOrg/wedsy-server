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

/**
 * The NATIONAL part of a number, for a gateway that wants it without the
 * country code — Fast2SMS's `numbers` field, for one.
 *
 * Returns null when the number does not start with the code asked for. That
 * refusal is the point: the previous implementation did
 * `phone.replace("+91", "")`, which silently does NOTHING to "+971501234567"
 * and hands the gateway a string with a "+" in it. A caller that cannot get a
 * national number back must decide what to do about it, not send a mangled one.
 *
 * @param {string} raw
 * @param {string} [cc]  country code to strip; defaults to DEFAULT_COUNTRY_CODE
 * @returns {string|null}
 */
const nationalFor = (raw, cc = defaultCountryCode()) => {
  const full = normalisePhone(raw);
  if (!full) return null;
  const code = String(cc).replace(/[^0-9]/g, "");
  if (!code || !full.startsWith(code)) return null;
  const national = full.slice(code.length);
  return national.length >= 6 ? national : null;
};

/**
 * The leading digits of a number, for a log line.
 *
 * DELIBERATELY NOT "the country code". Splitting a country code out requires a
 * per-country numbering table — the national part is ten digits in India and
 * nine in the UAE, so any fixed-width split turns +971 into +97. This returns
 * what can be claimed honestly: the first few digits, enough to identify which
 * country a skipped number belongs to when someone reads the log.
 */
const leadingDigits = (raw, n = 4) => {
  const full = normalisePhone(raw);
  return full ? full.slice(0, n) : "";
};

/**
 * Does this stored value carry a country code of its own?
 *
 * The same test rule 1 of normalisePhone uses: a leading "+", or more than ten
 * digits once the trunk zero is off. Exported because the dedup guard needs to
 * ask the question without re-deriving the answer — two implementations of
 * "has a country code" is exactly how the guard and the normaliser would drift.
 *
 * An "ig:" placeholder is not a number at all, so it carries nothing.
 */
const hasExplicitCountryCode = (raw) => {
  const original = String(raw || "").trim();
  if (!original || isPlaceholder(original)) return false;
  if (original.startsWith("+")) return true;
  return original.replace(/[^0-9]/g, "").replace(/^0+/, "").length > 10;
};

module.exports = {
  normalisePhone,
  defaultCountryCode,
  isPlaceholder,
  nationalFor,
  leadingDigits,
  hasExplicitCountryCode,
};
