// Demo panel pricing — pure logic for POST /decor/demo-price.
//
// Turns a vision-identified category into a client-facing PRICE LADDER. No DB,
// no vision, no network here — the controller runs vision + queries comparables
// (pre-filtered to productVisibility:true AND productAvailability:true) and hands
// them in, so this stays unit-testable. Retrieval / similarity is descoped:
// examples are scale/price-point proof, never "matches".
//
// The panel is a NEGOTIATING ANCHOR, not a description of catalogue prices:
// staff quote from it and expect the client to bargain down, so every figure
// carries deliberate headroom above the real price (a business decision, not a
// statistic).
//
// Sized rows (Stage & Mandap) are SMOOTHED across sizes: one reference size per
// category anchors on the p75 of its live orderable natural prices (premium
// outliers excluded; engine size-lookup fallback), and every other row derives
// as reference × (area ratio ^ DECOR_AREA_EXPONENT). Per-bucket anchoring
// produced nonsense — 16x16 cheaper than 16x12, 30x16 at 2.36× the 24x16 price
// for 1.25× the area — because each bucket's comparables carry their own
// history. One anchor + a power law guarantees prices increase monotonically
// with area. Tiers derive via the demo ladder; each displays as a range whose
// LOW end is the anchored figure and whose high is low / 0.8.
//
// Every other category → a single category-band row (size doesn't predict price
// there), each applicable tier anchored on its own p75.

const { suggestPrice, CATEGORY_TIERS, SIZE_LOOKUP, TIER_LADDER, PREMIUM_OUTLIERS } = require("./decorPricing");

// Common size buckets to show, in the order the panel lists them. Only these
// two categories get a size ladder.
const SIZE_BUCKETS = {
  Stage: [[16, 12], [24, 16], [16, 16], [30, 16], [20, 16], [12, 8], [8, 8], [40, 20]],
  Mandap: [[16, 16], [12, 12], [20, 20], [15, 15], [20, 16]],
};

// ── Demo anchoring config ────────────────────────────────────────────────────
// Negotiating headroom applied to EVERY demo figure. Deliberately SEPARATE from
// DECOR_PRICE_UPLIFT (×1.20): that one belongs to the draft/new-build path and
// answers "what should this new product cost", while headroom answers "where do
// we open a negotiation". Do not merge them.
const DECOR_DEMO_HEADROOM = Number(process.env.DECOR_DEMO_HEADROOM) || 1.15;

// The anchored figure is the LOW end of the displayed range; low sits 20% below
// the top (high = low / 0.8). A proportional spread scales across categories —
// a fixed rupee spread would exceed the entire price of a Nameboard.
const DEMO_RANGE_LOW_FRACTION = 0.8;

// Reference size per sized category (founder-confirmed 2026-08): the ONE bucket
// whose live p75 anchors the whole ladder. Every other row scales by
// (area / reference area) ^ DECOR_AREA_EXPONENT. At 0.95, Stage 30x16 lands
// ~24% above 24x16 — matching the founder's "30ft should be 20-25% more than
// 24ft" — and monotonicity with area holds by construction.
const REFERENCE_SIZE = { Stage: [24, 16], Mandap: [12, 12] };
const DECOR_AREA_EXPONENT = Number(process.env.DECOR_AREA_EXPONENT) || 0.95;

// Demo tier ladder (ratios relative to artificial). Mandap is founder-specified
// (fresh = 1.8× artificial, mixed = 1.4×); every other category keeps the
// engine's historical Rule 4 ratios for now.
const DEMO_TIER_LADDER = {
  ...TIER_LADDER,
  Mandap: { mixed: 1.4, natural: 1.8 },
};

const num = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
const positive = (v) => num(v) !== null && num(v) > 0;

// Percentile on an ASCENDING-sorted numeric array (linear interpolation) —
// same maths as the engine's observedBand, so demo ranges and bands agree.
const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  return next !== undefined ? sorted[base] + rest * (next - sorted[base]) : sorted[base];
};
const sortedTierPrices = (comps, tier, outliers) =>
  comps
    .filter((c) => c && !outliers.has(c.id) && c.prices && positive(c.prices[tier]))
    .map((c) => c.prices[tier])
    .sort((a, b) => a - b);

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

// ₹500 rounding keeps figures quotable on a call ("fifty-seven and a half")
// without visibly machine-precise endings.
const round500 = (v) => Math.round(v / 500) * 500;
const rangeFromLow = (low) => ({
  low: round500(low),
  high: round500(low / DEMO_RANGE_LOW_FRACTION),
});

// Ladder a headroomed natural anchor into per-tier display ranges.
const ladderRanges = (natAnchor, ladder) => {
  const art = natAnchor / ladder.natural;
  return {
    artificial: rangeFromLow(art),
    mixed: rangeFromLow(art * ladder.mixed),
    natural: rangeFromLow(natAnchor),
  };
};

// The category's single natural-tier anchor: p75 of the REFERENCE bucket's
// live orderable naturals (outliers excluded — and the p25 end is superseded
// pricing, so it is deliberately not part of the anchor) × headroom. Falls back
// to the engine's size lookup at the reference size when that bucket has no
// live comparables.
const referenceAnchor = (category, comps) => {
  const [rl, rw] = REFERENCE_SIZE[category];
  const outliers = new Set(PREMIUM_OUTLIERS[category] || []);
  const matched = comps
    .filter((c) => c && sameSize(c, rl, rw))
    .filter((c) => !outliers.has(c.id) && c.prices && positive(c.prices.natural))
    .map((c) => c.prices.natural)
    .sort((a, b) => a - b);
  if (matched.length) {
    return {
      size: `${rl}x${rw}`,
      area: rl * rw,
      natAnchor: quantile(matched, 0.75) * DECOR_DEMO_HEADROOM,
      priceBasis: "live",
      comparablesUsed: matched.length,
    };
  }
  const point = suggestPrice({ category, length: rl, width: rw, mode: "demo", source: "internal" }, comps).suggested;
  return {
    size: `${rl}x${rw}`,
    area: rl * rw,
    natAnchor: positive(point.natural) ? point.natural * DECOR_DEMO_HEADROOM : null,
    priceBasis: "lookup",
    comparablesUsed: 0,
  };
};

// Category-band ranges (no size) for the non-sized single row: each applicable
// tier anchors on the p75 of its own live comparable prices, headroomed. A tier
// with no priced comparables stays null rather than borrowing another tier's.
const rangesForCategory = (category, tiers, comps) => {
  const outliers = new Set(PREMIUM_OUTLIERS[category] || []);
  const prices = {};
  tiers.forEach((tier) => {
    const vals = sortedTierPrices(comps, tier, outliers);
    prices[tier] = vals.length ? rangeFromLow(quantile(vals, 0.75) * DECOR_DEMO_HEADROOM) : null;
  });
  return prices;
};

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
  let anchor = null;
  if (sized) {
    anchor = referenceAnchor(category, comps);
    const tierLadder = DEMO_TIER_LADDER[category];
    ladder = buckets.map(([l, w]) => {
      const natAnchor =
        anchor.natAnchor == null
          ? null
          : anchor.natAnchor * Math.pow((l * w) / anchor.area, DECOR_AREA_EXPONENT);
      const row = {
        size: `${l}x${w}`,
        area: l * w,
        // smoothed from the single reference anchor — monotonic in area
        prices: natAnchor == null ? {} : ladderRanges(natAnchor, tierLadder),
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
    const row = { size: null, prices: rangesForCategory(category, tiers, comps) };
    if (includeExamples) {
      row.examplesAtThisSize = withImage.slice(0, 3).map((c) => exampleOf(c, bandTier));
    }
    ladder = [row];
  }

  return {
    rejected: false,
    category,
    categoryConfidence: analysis.categoryConfidence,
    // Vision observations in the founder's vocabulary — evidence for the staff
    // member to place the quote within the range. NEVER graded, never priced on
    // (the Phase 3 gate proved they don't predict price).
    observations: Array.isArray(analysis.observations) ? analysis.observations : [],
    // Vision size signals for the panel: hide rows below the minimum buildable
    // width, badge the best-fit size. Advisory only — never move a price.
    minBuildWidth: analysis.minBuildWidth || null,
    recommendedSize: analysis.recommendedSize || null,
    applicableTiers: tiers,
    sized,
    upliftApplied: 1, // the ×1.20 draft-path uplift never applies to the demo
    headroomApplied: DECOR_DEMO_HEADROOM, // negotiating headroom baked into every figure
    ...(anchor ? { anchor: { size: anchor.size, priceBasis: anchor.priceBasis, comparablesUsed: anchor.comparablesUsed } } : {}),
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

module.exports = {
  buildDemoPrice,
  pinTextCategoryCheck,
  SIZE_BUCKETS,
  DECOR_DEMO_HEADROOM,
  DEMO_TIER_LADDER,
  REFERENCE_SIZE,
  DECOR_AREA_EXPONENT,
};
