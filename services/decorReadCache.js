// ── Pin-level read cache — lookup, store, and the "already in the store" answer
//
// The one job: make a revisit of the same image return the same read. See
// models/DecorImageRead for why (temperature-1.0 vision, ±25% width noise) and
// for what is and is not cached (the ANALYSIS, never the computed ladder).
//
// No vision and no HTTP in here. The controller still owns the AI call; this
// module only answers "have we read this image before?" and "is it already a
// product?".

const DecorImageRead = require("../models/DecorImageRead");
const DecorDraft = require("../models/DecorDraft");
const Decor = require("../models/Decor");
const { imageKeyFor, normalizeImageUrl } = require("./decorImageKey");
const { buildDemoPrice, demoCategoryTiers, resolveOccasion } = require("./decorDemoPrice");
const { normalizeComparable } = require("./decorPricing");

// ─────────────────────────────────────────────────────────────────────────────
// THE KEY FILTER — $or over BOTH keys.
//
// ⚠️ DELIBERATE DIVERGENCE from DecorDraftService's dedupeFilterFor, which is
// pinId-first-either-or (see the matching note there). Ruled 2026-08-17.
//
// A cache MISS is cheap and self-correcting: we pay for one more read. A cache
// that misses when it should hit is exactly the bug this feature exists to fix,
// so it matches as widely as it can — if either key is known to us, it is the
// same image. A2S dedupe keeps the narrower either-or shape because a false
// POSITIVE there is expensive in the other direction: it refuses a legitimate
// add with "already in the store".
// ─────────────────────────────────────────────────────────────────────────────
const cacheFilterFor = ({ pinId, normalizedUrl }) => {
  const or = [];
  if (pinId) or.push({ pinId });
  if (normalizedUrl) or.push({ normalizedUrl });
  return or.length === 1 ? or[0] : { $or: or };
};

// Same filter shape against DecorDraft's nested sourceImage paths.
const draftFilterFor = ({ pinId, normalizedUrl }) => {
  const or = [];
  if (pinId) or.push({ "sourceImage.pinId": pinId });
  if (normalizedUrl) or.push({ "sourceImage.normalizedUrl": normalizedUrl });
  return or.length === 1 ? or[0] : { $or: or };
};

// ── (b) the cache hit ───────────────────────────────────────────────────────
// OLDEST entry wins. Two concurrent first-reads of the same pin can both insert
// (the keys are deliberately not unique — see the model), and if we served the
// newest, the answer for that image would flip between them. Oldest-wins makes
// a duplicated entry harmless instead of a source of the very drift we are
// removing.
const lookupRead = async ({ pinId, imageUrl, normalizedUrl } = {}) => {
  const key = normalizedUrl !== undefined ? { pinId, normalizedUrl } : imageKeyFor({ imageUrl, pinId });
  if (!key.pinId && !key.normalizedUrl) return null;
  const entry = await DecorImageRead.findOne({ ...cacheFilterFor(key), mode: "demo" })
    .sort({ firstReadAt: 1, _id: 1 })
    .lean();
  if (!entry || !entry.analysis || typeof entry.analysis !== "object") return null;
  return entry;
};

// Mark a hit. Fire-and-forget: a failed counter must never fail the request.
const touchRead = async (id) => {
  try {
    await DecorImageRead.updateOne({ _id: id }, { $inc: { hits: 1 }, $set: { lastServedAt: new Date() } });
  } catch (e) {
    console.warn("[decorReadCache] touch failed", e && e.message);
  }
};

// ── (c) store a fresh read ──────────────────────────────────────────────────
// `reanalyse:true` OVERWRITES the entry the lookup would have served (the
// oldest), so the forced re-read becomes the new stable answer rather than
// creating a second entry the lookup would ignore.
const storeRead = async ({ pinId, imageUrl, analysis, reanalyse } = {}, actorId) => {
  const key = imageKeyFor({ imageUrl, pinId });
  if (!key.usable) return null;
  try {
    const existing = await DecorImageRead.findOne({ ...cacheFilterFor(key), mode: "demo" })
      .sort({ firstReadAt: 1, _id: 1 })
      .lean();

    if (existing) {
      // Only a deliberate reanalyse may replace a stored read. Anything else
      // reaching here means the lookup missed and then something inserted
      // concurrently — keep the older read, which is what lookups will serve.
      if (!reanalyse) return existing;
      await DecorImageRead.updateOne(
        { _id: existing._id },
        {
          $set: {
            analysis,
            // Backfill the key that was missing when the entry was first written
            // (a pinId-less first read, later revisited with one).
            ...(key.pinId ? { pinId: key.pinId } : {}),
            ...(key.normalizedUrl ? { normalizedUrl: key.normalizedUrl } : {}),
            sourceUrl: String(imageUrl || ""),
            lastReanalysedAt: new Date(),
            readBy: actorId || null,
          },
          $inc: { reads: 1 },
        }
      );
      return await DecorImageRead.findById(existing._id).lean();
    }

    const doc = await DecorImageRead.create({
      pinId: key.pinId,
      normalizedUrl: key.normalizedUrl,
      sourceUrl: String(imageUrl || ""),
      analysis,
      mode: "demo",
      firstReadAt: new Date(),
      reads: 1,
      readBy: actorId || null,
    });
    return doc.toObject();
  } catch (e) {
    // A cache write failure must never break a live sales call. The read was
    // already paid for and the client already has an answer.
    console.warn("[decorReadCache] store failed", e && e.message);
    return null;
  }
};

// ── (a) the pin is already a product ────────────────────────────────────────
// An APPROVED draft with a publishedDecorId that still resolves. The live Decor
// wins over any cached read: a human priced it, and that price is the truth.
const publishedForImage = async ({ pinId, imageUrl } = {}) => {
  const key = imageKeyFor({ imageUrl, pinId });
  if (!key.usable) return null;
  const draft = await DecorDraft.findOne({
    ...draftFilterFor(key),
    status: "approved",
    publishedDecorId: { $ne: null },
  })
    .sort({ addedAt: -1, _id: -1 })
    .lean();
  if (!draft) return null;
  const decor = await Decor.findById(draft.publishedDecorId).lean();
  // A draft pointing at a deleted product is not an answer — fall through to the
  // cache so the panel still gets a price.
  if (!decor) return null;
  return { draft, decor };
};

// ─────────────────────────────────────────────────────────────────────────────
// THE PANEL'S NUMBER — replayed for A2S.
//
// Ruling (2026-08-17): "what is shown on the extension and what is added when
// A2S is clicked must be the same". The panel and the draft engine are two
// different pricing models (floral-run × 1.15 headroom vs comparable-median ×
// SIZE_LOOKUP × TIER_LADDER) and caching the READ cannot make them agree — so
// A2S takes the PANEL's number as the pre-filled price in the approval modal,
// headroom included, and keeps the draft engine's ladder alongside it as the
// untouched training "before".
//
// This recomputes the ladder from the SAME cached analysis, the SAME occasion
// resolution and the SAME comparable query the controller uses, so the figure is
// the one the client was quoted rather than a second estimate of it.
// ─────────────────────────────────────────────────────────────────────────────
const round500 = (n) => Math.round(n / 500) * 500;

// Which row was the client looking at? A floral-run or band ladder has exactly
// one. A size ladder has many, and the panel badges the vision's best-fit size —
// so that row is the quote; failing that, the row nearest the read's own area.
const pickPanelRow = (ladder, analysis) => {
  const rows = Array.isArray(ladder) ? ladder.filter(Boolean) : [];
  if (rows.length <= 1) return rows[0] || null;
  const rec = analysis && analysis.recommendedSize;
  if (rec) {
    const hit = rows.find((r) => r.size === rec);
    if (hit) return hit;
  }
  const size = (analysis && analysis.size) || {};
  const area = Number(size.length) * Number(size.width);
  if (Number.isFinite(area) && area > 0) {
    return rows.reduce((best, r) =>
      Math.abs((r.area || 0) - area) < Math.abs((best.area || 0) - area) ? r : best
    );
  }
  return rows[0];
};

const panelQuoteFor = async (analysis, { pinText } = {}) => {
  if (!analysis || analysis.isDecorProduct === false || !analysis.category) return null;
  const occasion = resolveOccasion(pinText, analysis.occasion);
  const docs = await Decor.find(
    { category: analysis.category, productVisibility: true, productAvailability: true },
    "name productInfo.id productInfo.measurements productTypes image thumbnail"
  ).lean();
  const out = buildDemoPrice(analysis, docs.map(normalizeComparable), {
    includeExamples: false,
    occasion,
  });
  if (!out || out.rejected) return null;

  const row = pickPanelRow(out.ladder, analysis);
  if (!row || !row.prices) return null;

  // The tier the PUBLISH step will name (approveDraft uses the category's first
  // applicable tier), so the pre-filled number and the published productTypes
  // row describe the same flower tier. Recorded explicitly — never inferred.
  const tiers = demoCategoryTiers(out.category) || [];
  const tier = tiers.find((t) => row.prices[t]) || Object.keys(row.prices)[0] || null;
  const range = tier ? row.prices[tier] : null;
  if (!range || range.low == null || range.high == null) return null;

  return {
    // buildDemoPrice may relabel Stage→Haldi on a haldi caption. The panel
    // priced THAT category; the draft's own category comes from the vision read.
    // Both are recorded so a divergence is visible instead of silently mixed.
    category: out.category,
    tier,
    size: row.size || null,
    low: range.low,
    high: range.high,
    // The pre-filled price. Rounded to ₹500 like every figure on the ladder.
    midpoint: round500((Number(range.low) + Number(range.high)) / 2),
    // The ×1.15 negotiating headroom STAYS IN, so the store price matches what
    // the client was quoted (ruling 3).
    headroomApplied: out.headroomApplied,
    floralRunPriced: !!out.floralRunPriced,
  };
};

module.exports = {
  cacheFilterFor,
  draftFilterFor,
  lookupRead,
  touchRead,
  storeRead,
  publishedForImage,
  panelQuoteFor,
  pickPanelRow,
  normalizeImageUrl,
  imageKeyFor,
};
