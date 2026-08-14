const Decor = require("../models/Decor");

// ── Server-side product-code generator ───────────────────────────────────────
// Format (confirmed from prod after the Aug-2026 catalogue clean):
//   lowercase prefix + 3-digit zero-pad, ONE prefix per category.
//
// Two bugs in the legacy client-side path are deliberately NOT inherited:
//   1. `getLastIdFor` sorts { "productInfo.id": -1 } — a LEXICOGRAPHIC sort, so
//      "st99" ranks above "st100". We take the max NUMERIC suffix instead.
//   2. It never checked uniqueness. We check GLOBALLY (not per-category),
//      because a prefix is not confined to its category in practice — e.g.
//      np001 currently sits on a Stage product.
//
// The result is a SUGGESTION only: the approver may override it, and
// uniqueness is re-checked at approve time against the live collection.

// Last-resort map, used ONLY when a category has no coded products to learn
// from. The prefix is normally DERIVED from existing data (below) — never
// computed from the category name's letters.
const FALLBACK_PREFIX = {
  Stage: "st",
  Mandap: "ma",
  Nameboard: "na",
  Photobooth: "ph",
  Pathway: "pa",
  "Mala & More": "mm",
  Entrance: "e",
  "Phoolon Ki Chadar": "pc",
  Partitions: "np",
  Furniture: "f",
  "Sound & Light": "sl",
  "Entries & Effects": "ee",
};

const CODE_RE = /^([A-Za-z]+)(\d+)$/;

const parseCode = (raw) => {
  const m = CODE_RE.exec(String(raw || "").trim());
  return m ? { prefix: m[1].toLowerCase(), n: parseInt(m[2], 10) } : null;
};

// Derive the prefix for a category from what that category ALREADY uses:
// the most common well-formed prefix among its products wins.
const prefixForCategory = async (category) => {
  if (!category) return null;
  const docs = await Decor.find(
    { category, "productInfo.id": { $nin: [null, ""] } },
    { "productInfo.id": 1 }
  ).lean();

  const counts = new Map();
  for (const d of docs) {
    const parsed = parseCode(d.productInfo && d.productInfo.id);
    if (!parsed) continue;
    counts.set(parsed.prefix, (counts.get(parsed.prefix) || 0) + 1);
  }
  if (counts.size) {
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }
  return FALLBACK_PREFIX[category] || null;
};

// Highest numeric suffix in use for a prefix, across the WHOLE collection.
const maxSuffixForPrefix = async (prefix) => {
  const docs = await Decor.find(
    { "productInfo.id": { $regex: `^${prefix}\\d+$`, $options: "i" } },
    { "productInfo.id": 1 }
  ).lean();

  let max = 0;
  for (const d of docs) {
    const parsed = parseCode(d.productInfo && d.productInfo.id);
    if (parsed && parsed.prefix === prefix && parsed.n > max) max = parsed.n;
  }
  return max;
};

const isCodeTaken = async (code) => {
  if (!code) return false;
  return !!(await Decor.exists({ "productInfo.id": code }));
};

// Suggest the next free code for a category. Returns "" when the category has
// no prefix we can justify (rather than inventing one).
const suggestProductCode = async (category) => {
  const prefix = await prefixForCategory(category);
  if (!prefix) return "";

  let n = (await maxSuffixForPrefix(prefix)) + 1;
  // Walk forward past anything already taken (gaps, or codes created since).
  for (let guard = 0; guard < 10000; guard++, n++) {
    const code = `${prefix}${String(n).padStart(3, "0")}`;
    if (!(await isCodeTaken(code))) return code;
  }
  return "";
};

module.exports = {
  suggestProductCode,
  prefixForCategory,
  maxSuffixForPrefix,
  isCodeTaken,
  parseCode,
  FALLBACK_PREFIX,
};
