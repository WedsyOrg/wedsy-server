const Decor = require("../models/Decor");
const DecorDraft = require("../models/DecorDraft");
const Category = require("../models/Category");

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
// As of 2026-09 the category's own DECLARED prefix wins first —
// Category.codePrefix, set when the category is created/edited and normalised
// there to lowercase letters. That is what lets a brand-new category (no coded
// products, no FALLBACK_PREFIX entry) mint codes from its first draft instead
// of arriving blank. Empty/absent declares nothing → today's behaviour,
// unchanged for every pre-flag category.
const prefixForCategory = async (category) => {
  if (!category) return null;
  const catDoc = await Category.findOne({ name: category }, { codePrefix: 1 }).lean();
  if (catDoc && catDoc.codePrefix) return catDoc.codePrefix;
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

// ─────────────────────────────────────────────────────────────────────────────
// TWO SEPARATE QUESTIONS. Do not merge them.
//
//   isCodeTaken(code)     — is this code LIVE IN THE CATALOGUE?
//   isCodeReserved(code)  — is a QUEUED DRAFT holding it?
//
// ⚠️ isCodeTaken MUST NOT become drafts-aware. approveDraft calls it to decide
// whether a code collides, and a draft always holds its own provisional code —
// so a drafts-aware isCodeTaken would make EVERY draft block its own approval.
// The separation is pinned by a test ("a code held only by a queued draft is
// NOT 'taken'"), so this cannot drift back together unnoticed.
const isCodeTaken = async (code) => {
  if (!code) return false;
  return !!(await Decor.exists({ "productInfo.id": code }));
};

// Codes spoken for by drafts still sitting in the approvals queue.
//
// WHY THIS EXISTS: the generator read only the catalogue, so every draft created
// before the first approval was handed the same "next free" code — five queued
// drafts all carrying st236, and the second approval 409ing after the approver
// had already done the review. A queued draft's code is a RESERVATION.
//
// Scoped to status:"queued" deliberately. An approved draft's code is live in
// the catalogue and isCodeTaken already covers it; a REJECTED draft's code
// should go back in the pool rather than leaving a permanent gap.
const reservedDraftCodes = async (prefix) => {
  const match = prefix
    ? { $regex: `^${prefix}\\d+$`, $options: "i" }
    : { $nin: [null, ""] };
  const docs = await DecorDraft.find(
    { status: "queued", "draft.productCode": match },
    { "draft.productCode": 1 }
  ).lean();
  return new Set(
    docs
      .map((d) => String((d.draft && d.draft.productCode) || "").trim().toLowerCase())
      .filter(Boolean)
  );
};

const isCodeReserved = async (code) => {
  if (!code) return false;
  const reserved = await reservedDraftCodes(null);
  return reserved.has(String(code).trim().toLowerCase());
};

// Suggest the next free code for a category. Returns "" when the category has
// no prefix we can justify (rather than inventing one).
// Suggest the next free code for a category. Returns "" when the category has
// no prefix we can justify (rather than inventing one).
//
// "Free" means neither LIVE in the catalogue nor RESERVED by a queued draft.
// `excludeDraftId` skips one draft's own reservation — used when re-deriving a
// code for that very draft, so it does not step over itself.
const suggestProductCode = async (category, { excludeDraftId } = {}) => {
  const prefix = await prefixForCategory(category);
  if (!prefix) return "";

  const reserved = await reservedDraftCodes(prefix);
  if (excludeDraftId) {
    const own = await DecorDraft.findById(excludeDraftId, { "draft.productCode": 1 }).lean();
    const ownCode = String((own && own.draft && own.draft.productCode) || "").trim().toLowerCase();
    if (ownCode) reserved.delete(ownCode);
  }

  let n = (await maxSuffixForPrefix(prefix)) + 1;
  // Walk forward past anything already taken (gaps, or codes created since) or
  // reserved by another queued draft.
  for (let guard = 0; guard < 10000; guard++, n++) {
    const code = `${prefix}${String(n).padStart(3, "0")}`;
    if (reserved.has(code.toLowerCase())) continue;
    if (!(await isCodeTaken(code))) return code;
  }
  return "";
};

module.exports = {
  suggestProductCode,
  prefixForCategory,
  maxSuffixForPrefix,
  isCodeTaken,
  isCodeReserved,
  reservedDraftCodes,
  parseCode,
  FALLBACK_PREFIX,
};
