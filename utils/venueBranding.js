/**
 * utils/venueBranding.js — the one place a document asks "who is this venue?"
 *
 * ── S1a IS AN AUDIT RESULT, NOT NEW STORAGE ─────────────────────────────────
 * Every field the brief lists already exists on Venue, added by earlier phases
 * and edited from two different Settings sections:
 *
 *   name              Venue.name                    Settings → Profile
 *   logo              Venue.logo                    Settings → Profile
 *   address           Venue.address / .formattedAddress   Settings → Profile
 *   phone / email     Venue.contact.* , .phone, .email    Settings → Profile
 *   GSTIN             Venue.gstin                   Settings → Billing & tax
 *   PAN               Venue.pan                     Settings → Billing & tax
 *   invoice prefix    Venue.invoicePrefix           Settings → Billing & tax
 *
 * So nothing is added here. What was missing is that each renderer reached for
 * these fields itself, with its own fallback order — utils/venuePdf reads
 * `venue.contact.primaryPhone || venue.phone`, BillingDocService reads a
 * Setting collection, and the invoice path reads neither. That is how a GSTIN
 * ends up on one document and not another.
 *
 * This resolves them ONCE, with one fallback order, so every generated document
 * says the same thing about the venue. The projection string below is exported
 * so callers cannot silently omit a field and make a venue look like it has no
 * GSTIN — the exact bug that made every venue look like it had no uploaded T&C
 * in #129.
 */

/**
 * Everything a document needs about the venue. Pass to any `.select()` so a
 * lean read cannot drop a branding field.
 */
const BRANDING_SELECT =
  "_id name slug logo address formattedAddress contact phone email gstin pan invoicePrefix settings whiteLabel";

const clean = (v) => {
  if (v === null || v === undefined) return "";
  const s = String(v).trim();
  return /^(undefined|null)$/i.test(s) ? "" : s;
};

/**
 * @param {object} venue a Venue doc or lean object selected with BRANDING_SELECT
 * @returns {{
 *   name: string, logo: string, address: string, phone: string, email: string,
 *   gstin: string, pan: string, invoicePrefix: string, whiteLabel: boolean,
 *   hasGstin: boolean, contactLine: string, taxLine: string
 * }}
 */
function resolveBranding(venue) {
  const v = venue || {};
  const c = v.contact || {};

  const name = clean(v.name);
  const logo = clean(v.logo);
  // formattedAddress is the Google-normalised one and is the better label when
  // present; `address` is what the owner typed.
  const address = clean(v.address) || clean(v.formattedAddress);
  const phone = clean(c.primaryPhone) || clean(v.phone);
  const email = clean(c.email) || clean(v.email);
  const gstin = clean(v.gstin);
  const pan = clean(v.pan);

  return {
    name,
    logo,
    address,
    phone,
    email,
    gstin,
    pan,
    invoicePrefix: clean(v.invoicePrefix),
    whiteLabel: Boolean(v.whiteLabel || (v.settings && v.settings.documentsWhiteLabelDefault)),
    // Whether a GST invoice is even possible. S5 makes GST optional per invoice,
    // but "optional" must not mean "offer it with no GSTIN to put on it".
    hasGstin: Boolean(gstin),
    // Pre-joined lines, so no renderer re-invents the separator. Absent parts
    // drop out rather than leaving a dangling bullet.
    contactLine: [address, phone, email].filter(Boolean).join("  •  "),
    taxLine: [gstin ? `GSTIN: ${gstin}` : "", pan ? `PAN: ${pan}` : ""].filter(Boolean).join("    "),
  };
}

module.exports = { resolveBranding, BRANDING_SELECT };
