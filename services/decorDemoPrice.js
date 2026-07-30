// Demo panel pricing — pure logic for POST /decor/demo-price.
//
// Turns a vision-identified category into a client-facing PRICE LADDER. No DB,
// no vision, no network here — the controller runs vision + queries comparables
// (pre-filtered to productVisibility:true AND productAvailability:true) and hands
// them in, so this stays unit-testable. Retrieval / similarity is descoped:
// examples are scale/price-point proof, never "matches".
//
// Sized rows (Stage & Mandap) are priced from LIVE size-matched orderable
// comparables, not a hardcoded table — the demo answers "what do existing
// orderable products cost", and a table goes stale as products are added. We
// take the natural-tier median of the bucket's orderable, non-premium-outlier
// products and derive the other tiers with the Rule 4 ladder. Premium outliers
// (>3× median) are excluded so one ₹350k build doesn't distort the "typical"
// price. If a bucket has no live comparables, we fall back to the engine's size
// lookup so the row still renders. (The draft/full path keeps the engine lookup.)
//
// Every other category → a single category-band row (size doesn't predict price
// there), whose prices already come from the live comparables via the engine.

const { suggestPrice, CATEGORY_TIERS, SIZE_LOOKUP, TIER_LADDER, PREMIUM_OUTLIERS } = require("./decorPricing");

// Common size buckets to show, in the order the panel lists them. Only these
// two categories get a size ladder.
const SIZE_BUCKETS = {
  Stage: [[16, 12], [24, 16], [16, 16], [30, 16], [20, 16], [12, 8], [8, 8], [40, 20]],
  Mandap: [[16, 16], [12, 12], [20, 20], [15, 15], [20, 16]],
};

const num = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
const positive = (v) => num(v) !== null && num(v) > 0;
const median = (values) => {
  const s = values.filter(positive).map(Number).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// The tier whose price labels an example product (richest applicable tier).
const bandTierOf = (tiers) =>
  ["natural", "mixed", "artificial", "flat"].find((t) => tiers.includes(t));

const exampleOf = (c, bandTier) => ({
  productCode: c.id,
  name: c.name,
  image: c.image,
  size: c.sizeLabel,
  price: c.prices ? (c.prices[bandTier] ?? null) : null,
});

// A product matches a ladder row when its stored dimensions equal the row's,
// either orientation. Exact dims (not nearest-area) keep the "30x16" row priced
// off exactly-30x16 products — so the demo agrees with SIZE_LOOKUP (both are
// exact-dims, outlier-excluded medians) instead of blending in nearby areas.
const sameSize = (c, l, w) =>
  c && c.length != null && c.width != null &&
  ((c.length === l && c.width === w) || (c.length === w && c.width === l));

// Per-size prices from LIVE orderable comparables: natural median (outliers
// excluded) → ladder-derived artificial/mixed. Falls back to the engine's size
// lookup when the bucket has no live comparables.
const livePricesForRow = (category, l, w, comps) => {
  const outliers = new Set(PREMIUM_OUTLIERS[category] || []);
  const ladder = TIER_LADDER[category];
  const matched = comps
    .filter((c) => c && !outliers.has(c.id) && sameSize(c, l, w) && c.prices && positive(c.prices.natural))
    .map((c) => c.prices.natural);
  const natLive = median(matched);
  if (natLive != null && ladder) {
    const artificial = natLive / ladder.natural;
    return {
      basis: "live",
      n: matched.length,
      prices: {
        artificial: Math.round(artificial),
        mixed: Math.round(artificial * ladder.mixed),
        natural: Math.round(natLive),
      },
    };
  }
  // no live comparables in this bucket → engine size lookup keeps the row honest
  const prices = suggestPrice({ category, length: l, width: w, mode: "demo", source: "internal" }, comps).suggested;
  return { basis: "lookup", n: 0, prices };
};

// Premium ceiling for a size bucket: the highest orderable price in that bucket
// INCLUDING premium outliers. A different claim from the typical price (which
// excludes them) — excluding outliers understates capability, and on a call the
// ceiling is an upsell lever. Never merged into the typical range.
const bucketCeiling = (category, l, w, comps, bandTier) => {
  const inBucket = comps.filter((c) => sameSize(c, l, w) && c.prices && positive(c.prices[bandTier]));
  if (!inBucket.length) return null;
  return Math.round(Math.max(...inBucket.map((c) => c.prices[bandTier])));
};

// Category-band prices (no size) for the non-sized single row — already derived
// from the live comparables by the engine (per-tier median / ladder).
const pricesForCategory = (category, comps) =>
  suggestPrice({ category, mode: "demo", source: "internal" }, comps).suggested;

// buildDemoPrice(analysis, comparables, opts) → the demo-price response object.
//   analysis: Phase B demo output { isDecorProduct, category, categoryConfidence, ... }
//   comparables: normalizeComparable() results, pre-filtered to visible+available
//   opts.includeExamples: attach up to 3 scale/price-point examples per row
const buildDemoPrice = (analysis, comparables, opts = {}) => {
  const includeExamples = !!opts.includeExamples;

  // Rejection escape hatch — not a décor product → no pricing.
  if (!analysis || analysis.isDecorProduct === false) {
    const reason =
      (analysis && analysis.complexity && analysis.complexity.reasoning) ||
      "This image doesn't look like a décor product.";
    return { rejected: true, reason };
  }

  const category = analysis.category;
  const tiers = CATEGORY_TIERS[category];
  if (!tiers) {
    return {
      rejected: true,
      reason: `Not a priceable décor category${category ? ` (${category})` : ""}.`,
    };
  }

  const comps = Array.isArray(comparables) ? comparables : [];
  const bandTier = bandTierOf(tiers);
  const buckets = SIZE_BUCKETS[category];
  const sized = !!buckets;
  const withImage = comps.filter((c) => c && c.image);

  let ladder;
  if (sized) {
    ladder = buckets.map(([l, w]) => {
      const { basis, n, prices } = livePricesForRow(category, l, w, comps);
      const row = {
        size: `${l}x${w}`,
        area: l * w,
        prices, // typical — premium outliers excluded
        premiumCeiling: bucketCeiling(category, l, w, comps, bandTier), // incl. outliers; separate claim
        priceBasis: basis,
        comparablesUsed: n,
      };
      if (includeExamples) {
        row.examplesAtThisSize = withImage
          .filter((c) => sameSize(c, l, w))
          .slice(0, 3)
          .map((c) => exampleOf(c, bandTier));
      }
      return row;
    });
  } else {
    const row = { size: null, prices: pricesForCategory(category, comps) };
    if (includeExamples) {
      row.examplesAtThisSize = withImage.slice(0, 3).map((c) => exampleOf(c, bandTier));
    }
    ladder = [row];
  }

  return {
    rejected: false,
    category,
    categoryConfidence: analysis.categoryConfidence,
    applicableTiers: tiers,
    sized,
    upliftApplied: 1, // raw catalogue prices — the ×1.20 uplift is draft-path only
    ladder,
  };
};

// Optional pin-text cross-check (spec: VERIFICATION only, never a prompt input,
// never shown to the client — a quiet staff signal). Compact Hinglish keyword
// map; returns the caption's implied category and whether it agrees with the
// model. Never overrides the model's category.
const PIN_KEYWORDS = {
  Mandap: ["mandap", "shaadi mandap", "vivah", "wedding mandap"],
  Stage: ["stage", "reception stage", "backdrop", "sangeet stage"],
  Entrance: ["entrance", "gate", "swagat", "welcome gate"],
  Pathway: ["aisle", "walkway", "pathway", "baraat path"],
  "Mala & More": ["varmala", "jaimala", "garland", "mala"],
  Nameboard: ["welcome board", "nameboard", "signage", "name sign"],
  Photobooth: ["photobooth", "selfie booth", "photo corner"],
  "Phoolon Ki Chadar": ["phoolon ki chadar", "flower chadar"],
};
const pinTextCategoryCheck = (pinText, modelCategory) => {
  if (!pinText || typeof pinText !== "string") return null;
  const t = pinText.toLowerCase();
  let detected = null;
  for (const [cat, words] of Object.entries(PIN_KEYWORDS)) {
    if (words.some((w) => t.includes(w))) { detected = cat; break; }
  }
  if (!detected) return { detectedCategory: null, agrees: null }; // uninformative
  return { detectedCategory: detected, agrees: detected === modelCategory };
};

module.exports = { buildDemoPrice, pinTextCategoryCheck, SIZE_BUCKETS };
