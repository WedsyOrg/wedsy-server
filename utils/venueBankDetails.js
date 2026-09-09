/**
 * utils/venueBankDetails.js — the venue's bank details, validated once at the
 * boundary where a person typed them.
 *
 * ── WHAT IS CHECKED AND WHAT DELIBERATELY IS NOT ────────────────────────────
 * The IFSC has a shape the RBI fixed (4 letters, a zero, 6 alphanumerics) and
 * a wrong one bounces a transfer — so a non-empty IFSC must match it. A UPI
 * ID is always name@psp; without the @ it cannot route, so that much is
 * required. EVERYTHING ELSE IS SHAPE-FREE ON PURPOSE (founder ruling): an
 * account number has no universal format — NRE accounts carry letters, some
 * banks pad with zeros that matter — and a venue entering an unusual account
 * correctly beats being refused by a rule we invented. Names, bank and branch
 * are free text with length caps only.
 *
 * All fields optional. Empty strings are legitimate ("not filled in yet") and
 * the documents print nothing for them — never an empty block.
 */

const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const UPI_RE = /^[A-Za-z0-9.\-_]{2,}@[A-Za-z]{2,}$/;

const clean = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

const BANK_FIELDS = ["accountName", "accountNumber", "ifsc", "bankName", "branch", "upiId"];

/** @returns {{ok:true, value:object, warnings:string[]} | {ok:false, message:string}} */
function validateBankDetails(input = {}) {
  const value = {};
  const warnings = [];
  for (const k of BANK_FIELDS) {
    if (input[k] === undefined) continue;
    value[k] = clean(input[k]);
  }
  if (value.accountName !== undefined && value.accountName.length > 120) {
    return { ok: false, message: "Account name is too long (max 120 characters)." };
  }
  if (value.bankName !== undefined && value.bankName.length > 120) {
    return { ok: false, message: "Bank name is too long (max 120 characters)." };
  }
  if (value.branch !== undefined && value.branch.length > 120) {
    return { ok: false, message: "Branch is too long (max 120 characters)." };
  }
  if (value.accountNumber !== undefined && value.accountNumber.length > 34) {
    // 34 is the IBAN ceiling — longer than any account number anywhere.
    return { ok: false, message: "Account number is too long (max 34 characters)." };
  }
  if (value.ifsc !== undefined && value.ifsc !== "") {
    value.ifsc = value.ifsc.toUpperCase();
    if (!IFSC_RE.test(value.ifsc)) {
      return { ok: false, message: "That IFSC doesn't look right — it is 4 letters, a zero, then 6 letters or digits (e.g. HDFC0001234)." };
    }
  }
  if (value.upiId !== undefined && value.upiId !== "") {
    if (!UPI_RE.test(value.upiId)) {
      return { ok: false, message: "That UPI ID doesn't look right — it reads name@bank (e.g. crownestate@icici)." };
    }
  }
  return { ok: true, value, warnings };
}

/** True when at least one field carries something printable. */
function hasBankDetails(bd) {
  if (!bd || typeof bd !== "object") return false;
  return BANK_FIELDS.some((k) => clean(bd[k]) !== "");
}

module.exports = { validateBankDetails, hasBankDetails, BANK_FIELDS };
