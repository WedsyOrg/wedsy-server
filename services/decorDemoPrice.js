// Demo panel pricing — pure logic for POST /decor/demo-price.
//
// Turns a vision-identified category into a client-facing PRICE LADDER using the
// Phase A pricing engine. No DB, no vision, no network here — the controller
// runs vision + queries comparables and hands them in, so this stays unit-
// testable. Retrieval / similarity is descoped: examples are scale/price-point
// proof, never "matches".
//
// Rules honoured:
//  • Stage & Mandap → one row per common size bucket (size moves price there).
//  • Every other category → a single row with the category band (size doesn't
//    predict price: Photobooth r=−0.16, Pathway 0.20, Entrance 0.29).
//  • Tiers are category-aware (pricing-engine Rule 1) — the engine's `suggested`
//    already contains only the applicable tiers, so we never invent one.
//  • Raw catalogue prices, NO uplift (source:'internal'); complexity is off in
//    demo mode. The human picks the size — the model's size estimate is ignored.

const { suggestPrice, CATEGORY_TIERS } = require("./decorPricing");

// Common size buckets to show, in the order the panel lists them. Only these
// two categories get a size ladder.
const SIZE_BUCKETS = {
  Stage: [[16, 12], [24, 16], [16, 16], [30, 16], [20, 16], [12, 8], [8, 8], [40, 20]],
  Mandap: [[16, 16], [12, 12], [20, 20], [15, 15], [20, 16]],
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

// Per-size prices for a Stage/Mandap row come from the engine's size lookup;
// comps only matter for the observed band (unused here) so an empty list is fine.
const pricesForSize = (category, l, w, comps) =>
  suggestPrice({ category, length: l, width: w, mode: "demo", source: "internal" }, comps).suggested;

// Category-band prices (no size) for the non-sized single row.
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
    const bucketAreas = buckets.map(([l, w]) => l * w);
    // Assign each example product to its single nearest displayed bucket.
    const nearestBucketIndex = (area) => {
      let best = 0, bestD = Infinity;
      bucketAreas.forEach((ba, j) => {
        const d = Math.abs(area - ba);
        if (d < bestD) { bestD = d; best = j; }
      });
      return best;
    };
    ladder = buckets.map(([l, w], bi) => {
      const row = { size: `${l}x${w}`, area: l * w, prices: pricesForSize(category, l, w, comps) };
      if (includeExamples) {
        row.examplesAtThisSize = withImage
          .filter((c) => c.area != null && nearestBucketIndex(c.area) === bi)
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
