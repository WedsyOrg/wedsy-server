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

// Which row was the client looking at? A size ladder has two rungs and the panel
// badges the recommended one; a band or floral-run reply has exactly one row.
// Failing a recommendedSize match, take the row nearest the read's own area.
const pickPanelRow = (rows, analysis) => {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (list.length <= 1) return list[0] || null;
  const rec = analysis && analysis.recommendedSize;
  if (rec) {
    const hit = list.find((r) => r.size === rec);
    if (hit) return hit;
  }
  const size = (analysis && analysis.size) || {};
  const area = Number(size.length) * Number(size.width);
  if (Number.isFinite(area) && area > 0) {
    return list.reduce((best, r) =>
      Math.abs((r.area || 0) - area) < Math.abs((best.area || 0) - area) ? r : best
    );
  }
  return list[0];
};

const panelQuoteFor = async (analysis, { pinText, occasion } = {}) => {
  if (!analysis || analysis.isDecorProduct === false || !analysis.category) return null;
  // ── Seam A (bulk upload, 2026-08-31) ──────────────────────────────────────
  // An EXPLICIT occasion — staff stated it at upload — takes precedence over
  // inference. Presence is keyed on `undefined`, NEVER truthiness: a caller
  // passing `occasion: null` means "no occasion, and do not infer one", and a
  // truthiness check would fall through to resolveOccasion and let a pinText
  // keyword resurrect exactly what the caller ruled out. The A2S path passes
  // only { pinText }, so it takes the resolveOccasion branch with the same
  // arguments as before this seam existed — byte-identical behaviour.
  // An explicit value must be resolveOccasion-shaped: { value, source, conflict }
  // (or null) — buildDemoPrice and buildSizeOptions read `.value` off it.
  const resolvedOccasion =
    occasion !== undefined ? occasion : resolveOccasion(pinText, analysis.occasion);
  const docs = await Decor.find(
    { category: analysis.category, productVisibility: true, productAvailability: true },
    "name productInfo.id productInfo.measurements productTypes image thumbnail"
  ).lean();
  const out = buildDemoPrice(analysis, docs.map(normalizeComparable), {
    includeExamples: false,
    occasion: resolvedOccasion,
  });
  if (!out || out.rejected) return null;

  // ── QUOTE FROM WHAT THE PANEL DISPLAYS (2026-08-21) ───────────────────────
  // This used to read out.ladder unconditionally, which on a Stage is the
  // FLORAL-RUN row — a figure the panel stopped displaying when it moved to size
  // options. The result was two prices for one pin: Ivory Cascade quoted ₹51,000
  // on floral run while the tier table read ₹93,333. The founder's requirement
  // has always been ONE number — what the client was quoted is what publishes —
  // so the quote now comes from the same rows the panel renders.
  //
  // sizeOptions exist for STAGE and MANDAP only (they are the only categories
  // with a REFERENCE_SIZE and SIZE_BUCKETS). The other ELEVEN — Haldi,
  // Photobooth, Entrance, Pathway, Nameboard, Mala & More, Phoolon Ki Chadar,
  // Partitions, Furniture, Sound & Light, Entries & Effects — have no size model,
  // so the panel displays the single ladder row and that is what we quote. Haldi
  // therefore keeps its floral-run quote, which is correct because floral run IS
  // its engine; it falls out of the rule rather than being a special case.
  const sized = Array.isArray(out.sizeOptions) && out.sizeOptions.length > 0;
  const rows = sized ? out.sizeOptions : out.ladder;
  const row = pickPanelRow(rows, analysis);
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
    // Which set of rows the quote came from, so a stored quote stays readable a
    // year from now without re-deriving it.
    basis: sized ? "size-ladder" : out.floralRunPriced ? "floral-run" : "category-band",
    low: range.low,
    high: range.high,
    // The pre-filled price. Rounded to ₹500 like every figure on the ladder.
    midpoint: round500((Number(range.low) + Number(range.high)) / 2),
    // The ×1.15 negotiating headroom STAYS IN, so the store price matches what
    // the client was quoted (ruling 3).
    headroomApplied: out.headroomApplied,
    floralRunPriced: !!out.floralRunPriced,
    // EVERY applicable tier of the quoted row, so the approval modal's tier table
    // can pre-fill each line from the same figures the client saw. `midpoint`
    // above stays the headline (applicableTiers[0]) exactly as before — this is
    // additive, and without it the table has no agreeing number to show for
    // mixed or natural.
    tierPrices: tiers.reduce((acc, t) => {
      const r = row.prices[t];
      if (r && r.low != null && r.high != null) {
        acc[t] = { low: r.low, high: r.high, midpoint: round500((Number(r.low) + Number(r.high)) / 2) };
      }
      return acc;
    }, {}),
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
