// Phase A — Décor pricing engine (AI Décor Suggester).
//
// PURE logic. No DB access, no writes, no new collection. The caller (the
// /decor/suggest-price controller) queries `decors`, maps each doc to a plain
// comparable via `normalizeComparable`, and hands the array in. Everything here
// is a deterministic function of (input, comparables) so it is unit-testable
// without a database.
//
// Rules and every number below are lifted verbatim from two Notion docs and are
// NOT re-derived here:
//   • AI Décor Suggester — Feature Spec, "PHASE A — PRICING ENGINE"
//   • Décor Pricing Playbook (v1) — bands, tier ladder, size lookup, outliers
//
// Pricing reads `productTypes[].sellingPrice` ONLY. `productInfo.variant.*` is a
// frozen legacy field the admin form never writes (verified across all three
// repos) — it is never read here.
//
// Pipeline, in spec order:
//   category → applicable tiers → base band from comparables
//     → size adjustment (Stage/Mandap ONLY) → tier ladder multipliers
//     → style → uplift
// The response ALWAYS carries observedBand + 3 comparables next to `suggested`,
// never a bare number — the approval screen shows evidence beside the figure.

// ── Config (env-overridable; never hardcoded into the derived bands) ──────────
// Extension-sourced drafts only; never applied to catalog reads / re-entry
// validation. Tunable so the multiplier can move without re-deriving the
// playbook and observed-vs-suggested stays visible.
const DECOR_PRICE_UPLIFT = Number(process.env.DECOR_PRICE_UPLIFT) || 1.2;

// ── Rule 1 — category determines applicable tiers ────────────────────────────
// Order matters: the FIRST entry is the ladder anchor (lowest applicable tier).
const CATEGORY_TIERS = {
  Stage: ["artificial", "mixed", "natural"],
  Photobooth: ["artificial", "mixed", "natural"],
  Entrance: ["artificial", "mixed", "natural"],
  Mandap: ["artificial", "mixed", "natural"],
  Pathway: ["artificial", "mixed", "natural", "flat"],
  Nameboard: ["natural"],
  "Mala & More": ["natural"],
  "Phoolon Ki Chadar": ["mixed", "natural"],
  Partitions: ["flat"],
  Furniture: ["flat"],
  "Sound & Light": ["flat"],
  "Entries & Effects": ["flat"],
};

// ── Rule 4 — tier ladder (median ratios within a product, relative to
// artificial). Only these categories expand tiers by ladder; the rest price
// each applicable tier from its own comparable median.
const TIER_LADDER = {
  Stage: { mixed: 1.22, natural: 1.44 },
  Mandap: { mixed: 1.3, natural: 1.56 },
  Pathway: { mixed: 1.25, natural: 1.46 },
  Photobooth: { mixed: 1.11, natural: 1.22 },
  Entrance: { mixed: 1.11, natural: 1.23 },
};

// ── Rule 3 — size lookup (Stage & Mandap ONLY; natural-tier medians by sqft).
// r=0.72 (Stage) / 0.61 (Mandap). Every other category ignores size entirely
// (Photobooth r=−0.16, Entrance 0.29, Pathway 0.20, Nameboard n/a).
const SIZE_ADJUSTED_CATEGORIES = ["Stage", "Mandap"];
const SIZE_LOOKUP = {
  Stage: {
    64: 25000,
    96: 37000,
    192: 46000,
    256: 45000,
    320: 60000,
    384: 80000,
    480: 180000,
    800: 257500,
  },
  Mandap: { 144: 64000, 256: 82000, 400: 151000 },
};

// ── Rule 5 — style premium (Stage only). Modern median ₹64,000 vs Traditional
// ₹45,000. Expressed relative to Modern (the dominant style the bands reflect:
// n=165 vs 25), so Modern is unchanged and Traditional is discounted to match
// its observed median. Applied only where style is confidently identified.
const STYLE_PREMIUM = {
  Stage: { Modern: 1.0, Traditional: 45000 / 64000 },
};

// ── Complexity → band position (Phase B). The backtest showed the residual
// error IS the design-complexity variable the engine was never given: two
// same-size stages differ up to 6×. Instead of always returning the median,
// the vision layer's complexity tier places the product within its own band.
//   simple → p25 · standard → median · elaborate → p75 · premium → above p75
// The factor is expressed relative to the median so it composes with the size
// lookup / ladder anchor (which already lands at the median).
const COMPLEXITY_POSITION = {
  simple: "p25",
  standard: "median",
  elaborate: "p75",
  premium: "above_p75",
};
const complexityAdjustment = (band, tier) => {
  if (!tier) return { applied: false, factor: 1, position: "median" };
  const med = band && band.median;
  const position = COMPLEXITY_POSITION[tier] || "median";
  if (!positive(med)) return { applied: true, factor: 1, position };
  let factor = 1;
  if (tier === "simple" && positive(band.p25)) factor = band.p25 / med;
  else if (tier === "elaborate" && positive(band.p75)) factor = band.p75 / med;
  // "above p75" = one more p75-sized step past the median.
  else if (tier === "premium" && positive(band.p75)) factor = (2 * band.p75 - med) / med;
  else factor = 1; // standard, or a tier the band can't support
  return { applied: true, factor, position };
};

// ── Rule 2 — premium outliers (>3× median): excluded from the median comps but
// their price is still reported as the band ceiling (max).
const PREMIUM_OUTLIERS = {
  Stage: ["st131", "st148", "st154", "st152", "st108"],
  Mandap: ["ma075"],
};

const CATEGORIES = Object.keys(CATEGORY_TIERS);

// ── numeric helpers ──────────────────────────────────────────────────────────
const num = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};
const positive = (v) => num(v) !== null && num(v) > 0;

// Tier normaliser — real catalog `productTypes[].name` values are messy:
// "Artificial Flowers"/"Artificial "/"Artificial flowers", "Mixed"/"Mixed ",
// "Natural"/"Natura" (typo), and "Price"/"Prices"/"Pricees" for flat. Keyword
// match survives all of them; anything unrecognised falls through to flat.
const tierOf = (name) => {
  const s = String(name || "").trim().toLowerCase();
  if (/artificial/.test(s)) return "artificial";
  if (/mixed/.test(s)) return "mixed";
  if (/natur/.test(s)) return "natural"; // matches "natural" and the "natura" typo
  return "flat";
};

// Percentile on an ASCENDING-sorted numeric array (linear interpolation).
const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  return next !== undefined ? sorted[base] + rest * (next - sorted[base]) : sorted[base];
};

const median = (values) => {
  const s = values.filter(positive).map(Number).sort((a, b) => a - b);
  return s.length ? quantile(s, 0.5) : null;
};

const nearestSizeBucket = (area, buckets) =>
  buckets.reduce((best, b) =>
    Math.abs(b - area) < Math.abs(best - area) ? b : best
  );

// ── comparable mapping ───────────────────────────────────────────────────────
// Raw Decor doc → plain comparable. Reads productTypes ONLY. When two rows map
// to the same tier (dirty data), the larger positive selling price wins.
const normalizeComparable = (doc = {}) => {
  const info = doc.productInfo || {};
  const m = info.measurements || {};
  const length = num(m.length);
  const width = num(m.width);
  const area = positive(m.area)
    ? num(m.area)
    : length && width
      ? length * width
      : null;

  const prices = {};
  (Array.isArray(doc.productTypes) ? doc.productTypes : []).forEach((pt) => {
    if (!pt) return;
    const tier = tierOf(pt.name);
    const price = num(pt.sellingPrice);
    if (price !== null && price > 0 && (prices[tier] === undefined || price > prices[tier])) {
      prices[tier] = price;
    }
  });

  return {
    id: info.id || (doc._id ? String(doc._id) : ""),
    name: doc.name || "",
    length,
    width,
    area,
    sizeLabel: length && width ? `${length}x${width}` : "",
    // Demo mode renders comparables as photographs, so carry an image URL.
    image: doc.image || doc.thumbnail || "",
    prices,
  };
};

// Resolve an area (sqft) from whatever the caller supplied.
const resolveArea = (input = {}) => {
  if (positive(input.area)) return num(input.area);
  const size = input.size;
  if (positive(size)) return num(size);
  if (size && typeof size === "object" && size.length && size.width) {
    return num(size.length) * num(size.width);
  }
  if (typeof size === "string") {
    const m = /(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/i.exec(size);
    if (m) return Number(m[1]) * Number(m[2]);
    if (positive(size)) return num(size);
  }
  if (input.length && input.width) return num(input.length) * num(input.width);
  return null;
};

// The band tier the observedBand + comparables are reported on: the richest
// applicable flower tier (natural > mixed > artificial), else flat.
const bandTierFor = (applicableTiers) =>
  ["natural", "mixed", "artificial", "flat"].find((t) => applicableTiers.includes(t));

// ── observedBand ─────────────────────────────────────────────────────────────
// Percentiles (min/p25/median/p75) exclude the premium outliers; max is the
// ceiling INCLUDING them; n counts every comparable that carries a band price.
const computeObservedBand = (comparables, bandTier, outliers) => {
  const outlierSet = new Set(outliers);
  const all = [];
  const kept = [];
  comparables.forEach((c) => {
    const p = c.prices && c.prices[bandTier];
    if (!positive(p)) return;
    all.push(p);
    if (!outlierSet.has(c.id)) kept.push(p);
  });
  if (!all.length) {
    return { min: null, p25: null, median: null, p75: null, max: null, n: 0 };
  }
  const s = kept.slice().sort((a, b) => a - b);
  const r = (v) => (v === null ? null : Math.round(v));
  return {
    min: r(s.length ? s[0] : null),
    p25: r(quantile(s, 0.25)),
    median: r(quantile(s, 0.5)),
    p75: r(quantile(s, 0.75)),
    max: r(Math.max(...all)), // ceiling includes the premium outliers
    n: all.length,
  };
};

// Pick the 3 most relevant comparables (outliers excluded). Sized categories
// rank by nearest area; everyone else by closeness to the band median.
const pickComparables = (comparables, bandTier, outliers, area, bandMedian) => {
  const outlierSet = new Set(outliers);
  const candidates = comparables.filter(
    (c) => !outlierSet.has(c.id) && positive(c.prices && c.prices[bandTier])
  );
  const anchor = area != null ? area : bandMedian;
  const keyOf = (c) => (area != null ? c.area : c.prices[bandTier]);
  candidates.sort((a, b) => {
    const da = keyOf(a) == null ? Infinity : Math.abs(keyOf(a) - anchor);
    const db = keyOf(b) == null ? Infinity : Math.abs(keyOf(b) - anchor);
    return da - db;
  });
  return candidates.slice(0, 3).map((c) => ({
    id: c.id,
    name: c.name,
    [bandTier]: c.prices[bandTier],
    size: c.sizeLabel,
    image: c.image || "",
  }));
};

// ── the engine ───────────────────────────────────────────────────────────────
// suggestPrice(input, comparables)
//   input: { category, size?|length?/width?|area?, style?, source? }
//   comparables: array of normalizeComparable() results
// Returns the response contract; throws on an unknown category.
const suggestPrice = (input = {}, comparables = []) => {
  const category = input.category;
  const applicableTiers = CATEGORY_TIERS[category];
  if (!applicableTiers) {
    const err = new Error(`Unknown décor category: ${JSON.stringify(category)}`);
    err.code = "UNKNOWN_CATEGORY";
    throw err;
  }

  const comps = (Array.isArray(comparables) ? comparables : []).filter(Boolean);
  const outliers = PREMIUM_OUTLIERS[category] || [];
  const outlierSet = new Set(outliers);
  const nonOutlier = comps.filter((c) => !outlierSet.has(c.id));

  // Step: base band from comparables (evidence) — reported on the band tier.
  const bandTier = bandTierFor(applicableTiers);
  const observedBand = computeObservedBand(comps, bandTier, outliers);

  // Step: base anchor. Ladder categories anchor on the lowest tier's median;
  // ladder-less categories price each tier from its own median (below).
  const anchorTier = applicableTiers[0];
  const medianOf = (tier) => median(nonOutlier.map((c) => c.prices[tier]));
  const ladder = TIER_LADDER[category];
  let baseAnchor = medianOf(anchorTier);

  // Step: size adjustment — Stage & Mandap ONLY. Every other category ignores
  // size even if the caller sent one. The size lookup is a natural-tier median,
  // so we divide back to the artificial anchor; the ladder re-multiplies it to
  // natural, preserving the looked-up figure exactly.
  const area = resolveArea(input);
  let sizeBasis = null;
  if (SIZE_ADJUSTED_CATEGORIES.includes(category) && area != null && ladder) {
    const buckets = Object.keys(SIZE_LOOKUP[category]).map(Number);
    const bucket = nearestSizeBucket(area, buckets);
    const naturalAtSize = SIZE_LOOKUP[category][bucket];
    baseAnchor = naturalAtSize / ladder.natural;
    sizeBasis = { area, bucket, naturalMedian: naturalAtSize };
  }

  // Step: tier ladder → build the suggested set.
  const suggested = {};
  if (ladder) {
    // Anchor + laddered flower tiers.
    if (applicableTiers.includes(anchorTier)) suggested[anchorTier] = baseAnchor;
    if (applicableTiers.includes("mixed")) suggested.mixed = baseAnchor * ladder.mixed;
    if (applicableTiers.includes("natural")) suggested.natural = baseAnchor * ladder.natural;
    // Pathway also carries a flat tier — priced from its own median, not the ladder.
    if (applicableTiers.includes("flat")) suggested.flat = medianOf("flat");
  } else {
    // No ladder (flat-only, natural-only, mixed+natural): per-tier median.
    applicableTiers.forEach((tier) => {
      suggested[tier] = medianOf(tier);
    });
  }

  // Step: complexity — place within the observed band (p25/median/p75/premium)
  // instead of always regressing to the median. Absent → standard (factor 1).
  const cx = complexityAdjustment(observedBand, input.complexity);

  // Step: style premium (Stage only, when confidently identified).
  const styleMap = STYLE_PREMIUM[category];
  const styleFactor =
    styleMap && input.style && styleMap[input.style] !== undefined
      ? styleMap[input.style]
      : 1;

  // Step: uplift — extension-sourced only. Never for catalog / re-entry reads.
  const upliftApplied = input.source === "extension" ? DECOR_PRICE_UPLIFT : 1;

  Object.keys(suggested).forEach((tier) => {
    const v = suggested[tier];
    suggested[tier] =
      v == null ? null : Math.round(v * cx.factor * styleFactor * upliftApplied);
  });

  const outComparables = pickComparables(
    comps,
    bandTier,
    outliers,
    SIZE_ADJUSTED_CATEGORIES.includes(category) ? area : null,
    observedBand.median
  );

  return {
    category,
    applicableTiers,
    observedBand,
    suggested,
    upliftApplied,
    comparables: outComparables,
    ...(sizeBasis ? { sizeBasis } : {}),
    ...(cx.applied
      ? {
          complexity: {
            tier: input.complexity,
            bandPosition: cx.position,
            factor: Number(cx.factor.toFixed(4)),
          },
        }
      : {}),
  };
};

module.exports = {
  suggestPrice,
  normalizeComparable,
  // exported for the controller, tests, and future tuning
  DECOR_PRICE_UPLIFT,
  CATEGORY_TIERS,
  TIER_LADDER,
  SIZE_LOOKUP,
  STYLE_PREMIUM,
  PREMIUM_OUTLIERS,
  CATEGORIES,
  tierOf,
};
