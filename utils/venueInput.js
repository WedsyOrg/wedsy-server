/**
 * utils/venueInput.js — shared hostile-input validation for venue write routes.
 * Helpers return { ok, value } or { ok:false, message } so controllers can 400
 * cleanly instead of 500-ing on bad casts (e.g. invalid dates) or storing junk.
 */
const MAXLEN = { name: 200, phone: 30, email: 200, text: 5000, label: 200, generic: 2000 };

const cleanStr = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

// Required short string (e.g. couple name/phone): non-blank, within maxlen.
function reqStr(v, field, max = MAXLEN.generic) {
  const s = cleanStr(v);
  if (!s) return { ok: false, message: `${field} is required` };
  if (s.length > max) return { ok: false, message: `${field} is too long (max ${max})` };
  return { ok: true, value: s };
}

// Optional string: blank allowed; within maxlen.
function optStr(v, field, max = MAXLEN.generic) {
  const s = cleanStr(v);
  if (s.length > max) return { ok: false, message: `${field} is too long (max ${max})` };
  return { ok: true, value: s };
}

// Strict date: rejects NaN and absurd years (outside 2000..2099). "" / null → null.
function optDate(v, field) {
  if (v == null || v === "") return { ok: true, value: null };
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return { ok: false, message: `${field} is not a valid date` };
  const y = d.getFullYear();
  if (y < 2000 || y >= 2100) return { ok: false, message: `${field} year is out of range` };
  return { ok: true, value: d };
}

// Optional non-negative number with an upper sanity cap. blank/undefined → undefined.
function optNumber(v, field, { min = 0, max = 1e12 } = {}) {
  if (v === undefined || v === null || v === "") return { ok: true, value: undefined };
  const n = Number(v);
  if (!Number.isFinite(n)) return { ok: false, message: `${field} must be a number` };
  if (n < min) return { ok: false, message: `${field} must be >= ${min}` };
  if (n > max) return { ok: false, message: `${field} is out of range` };
  return { ok: true, value: n };
}

// Optional positive integer count with a sanity cap (e.g. guestCount): >0.
function optCount(v, field, { max = 1e7 } = {}) {
  if (v === undefined || v === null || v === "") return { ok: true, value: undefined };
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, message: `${field} must be a positive whole number` };
  if (n > max) return { ok: false, message: `${field} is out of range` };
  return { ok: true, value: n };
}

// MB-CRM S0b: validate an optional event window. Returns
// { ok, checkIn, checkOut } (either may be null) or { ok:false, message }.
// Mirrors the model's pre-validate invariants so controllers 400 cleanly
// instead of relying on a 500 from the save-time hook.
const MS_PER_DAY = 24 * 60 * 60 * 1000;
function eventWindow(checkInRaw, checkOutRaw) {
  const ci = optDate(checkInRaw, "checkIn");
  if (!ci.ok) return ci;
  const co = optDate(checkOutRaw, "checkOut");
  if (!co.ok) return co;
  if (co.value && !ci.value) {
    return { ok: false, message: "checkIn is required when checkOut is set" };
  }
  if (ci.value && co.value) {
    if (co.value <= ci.value) return { ok: false, message: "checkOut must be after checkIn" };
    if (co.value - ci.value > 7 * MS_PER_DAY) {
      return { ok: false, message: "checkOut must be within 7 days of checkIn" };
    }
  }
  return { ok: true, checkIn: ci.value, checkOut: co.value };
}

module.exports = { MAXLEN, cleanStr, reqStr, optStr, optDate, optNumber, optCount, eventWindow };
