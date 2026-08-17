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
// STAGE is priced by running feet of FLORAL WALL, not floor area (founder,
// 2026-08): width alone does not set the price — the florals do. A 24ft
// backdrop that is a solid wall of flowers is ₹1,50,000 fresh; the same 24ft
// with only a top garland and side clusters is ₹75-80,000. Same width, half
// the price. fresh = floralRunFt × rate; artificial/mixed via Stage-specific
// divisors; range = ±spread around the headroomed figure. When the vision
// measurement is missing (e.g. a category override without a vision call),
// Stage falls back to the smoothed area ladder below so the panel never dies.
//
// MANDAP (and Stage fallback) rows are SMOOTHED across sizes: one reference
// size anchors on the p75 of its live orderable natural prices (premium
// outliers excluded; engine size-lookup fallback), and every other row derives
// as reference × (area ratio ^ DECOR_AREA_EXPONENT), guaranteeing prices
// increase monotonically with area. Tiers derive via the demo ladder; each
// displays as a range whose LOW end is the anchored figure (high = low / 0.8).
//
// Every other category → a single category-band row (size doesn't predict price
// there), each applicable tier anchored on its own p75.

const { suggestPrice, CATEGORY_TIERS, SIZE_LOOKUP, TIER_LADDER, PREMIUM_OUTLIERS, tierOf } = require("./decorPricing");

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

// ── Stage floral-run pricing (founder-calibrated 2026-08) ────────────────────
// fresh = floralRunFt × rate. At the calibration point — 24ft fully floral —
// this is ₹1,50,000 fresh / ₹1,00,000 mixed / ₹75,000 artificial; at ~12.5
// floral feet fresh lands near ₹78,000. Divisors are Stage-specific config,
// deliberately NOT the Mandap ladder.
const DECOR_FLORAL_RATE_PER_FT = Number(process.env.DECOR_FLORAL_RATE_PER_FT) || 6250;
const STAGE_TIER_DIVISORS = { artificial: 2, mixed: 1.5, natural: 1 }; // fresh / divisor
// Stage range: ±spread around the headroomed figure — the founder's own quoted
// spread (₹1,40,000-1,60,000 around ₹1,50,000 ≈ ±7%), not the 20% low-rule
// used by the area-anchored ladders.
const STAGE_RANGE_SPREAD = Number(process.env.DECOR_STAGE_RANGE_SPREAD) || 0.07;

// ── Structure charge (founder 2026-08, revised 2026-08-17) ───────────────────
// TWO BANDS, both charged as built surface area (width × height):
//
//   width < 30ft  → LIGHT band, ₹65/sqft, no geometry split. Even a build
//     assembled from existing inventory costs labour and consumables to erect.
//   width ≥ 30ft  → FABRICATED band, ₹390/sqft blocky · ₹500/sqft curved_ornate.
//     Built from scratch, so the rate is set by GEOMETRY.
//
// WHY THE LIGHT BAND EXISTS (2026-08-17). The original rule was "UNDER 30ft
// there is NO structure charge at all" — founder-stated, on the reasoning that
// those builds come out of existing inventory and nothing is fabricated. The
// catalogue analysis of 2026-08-17 disproved it: against the founder's OWN
// prices, the engine under-priced 106 of 126 Stage products with a MEDIAN
// SIGNED ERROR of −49.7%. The founder corrected the rule. ₹65/sqft was
// calibrated on the "Better Together" stage: 24.5ft × 12ft = 294 sqft × ₹65 =
// ₹19,110, which added to the ₹44,000-51,000 artificial floral lands ~₹63-70k
// against the founder's own ₹75,000 for that build. Landing slightly UNDER is
// deliberate and is the founder's call, not an error to correct.
//
// Calibration for the fabricated band is unchanged: a 60×12 blocky steel build
// is 720 sq ft × ₹390 ≈ ₹2.8L of structure, which with modest floral reaches
// the founder's ₹4L quote for that design. That ₹4L reference is a QUOTE — it
// already carries the negotiating margin — so the rate derived from it does NOT
// take DECOR_DEMO_HEADROOM on top; see floralRunPrices. The ₹65 light rate is
// treated the SAME way (flat addend, no ×1.15) for consistency with it.
//
// ⚠️ THE THRESHOLD CLIFF — KNOWN, DOCUMENTED, DELIBERATELY NOT SMOOTHED.
// At height 12ft: 29.9ft → 359 sqft × ₹65 = ₹23,322, but 30ft → 360 sqft × ₹390
// = ₹1,40,400. That is 6.0× for one tenth of a foot (7.7× on curved_ornate,
// ₹1,80,000). Nothing damps it — structureCharge is a hard branch, and
// sceneWidthCheck only FLAGS a disputed width, it never adjusts one.
// This matters because backdropWidthFt carries roughly ±25% read noise (the
// vision pipeline runs at temperature 1.0 and every sampling control is
// deprecated on the current model), so a build genuinely near 30ft can flip
// between ₹23,322 and ₹1,40,400 on two consecutive clicks of the same pin.
// The intended mitigation is PIN-LEVEL CACHING — analyse a pin once and replay
// the stored result — not a smoothing function here. Do not "fix" this by
// interpolating between the bands without a founder ruling: the two rates
// describe genuinely different work (erecting vs fabricating), and a blended
// rate in the middle would describe neither.
const STRUCTURE_MIN_WIDTH_FT = 30;
const DECOR_STRUCTURE_RATE_STEEL = Number(process.env.DECOR_STRUCTURE_RATE_STEEL) || 390;
const DECOR_STRUCTURE_RATE_FRP = Number(process.env.DECOR_STRUCTURE_RATE_FRP) || 500;
// Sub-30ft erection charge. Single rate — NO geometry split: below the
// fabrication threshold the cost is labour to put up an existing structure, and
// that does not depend on whether the panels are square or shaped.
const DECOR_STRUCTURE_RATE_LIGHT = Number(process.env.DECOR_STRUCTURE_RATE_LIGHT) || 65;
const STRUCTURE_RATES = { blocky: DECOR_STRUCTURE_RATE_STEEL, curved_ornate: DECOR_STRUCTURE_RATE_FRP };

// Always returns an object (except with no usable width) — staff details must
// be able to say WHICH BAND a build fell in, which a bare null cannot express.
//
// `applies`    — a structure charge of SOME kind is being added to the price.
// `fabricated` — the build is at/over the threshold and was built from scratch.
//                THIS is what drives the client-facing structureHeavy flag; the
//                light band must never set it, or "limited negotiating margin
//                on a fabricated build" would come to mean "any build at all".
// `band`       — "light" | "fabricated" | "no_height" | "exempt"
//
// fabricationExempt: HALDI. A haldi setup is a small floral backdrop the
// founder calibrated as deliberately cheap (₹3,000/ft vs the Stage ₹6,250) and
// involves essentially no fabrication, so it attracts NO structure charge at
// any width — not even the light band. Without this exemption a 9×12 haldi
// would gain 108 sqft × ₹65 = ₹7,020 on a ~₹27,000 build, a 26% increase to
// the one category explicitly priced to be affordable.
const structureCharge = (m, { fabricationExempt = false } = {}) => {
  if (!m) return null;
  const widthFt = Number(m.backdropWidthFt);
  const heightFt = Number(m.estimatedHeightFt);
  if (!(widthFt > 0)) return null;

  if (fabricationExempt) {
    return { applies: false, fabricated: false, band: "exempt", thresholdFt: STRUCTURE_MIN_WIDTH_FT, widthFt, cost: 0 };
  }

  // No height read → no surface area → nothing to charge, in EITHER band. At or
  // above the threshold that is a real hole (a 40ft build priced with zero
  // structure), so make it visible rather than silent. Deliberately NOT patched
  // with a fallback height: inventing a dimension to bill against is worse than
  // under-billing a case someone can see in the logs.
  if (!(heightFt > 0)) {
    if (widthFt >= STRUCTURE_MIN_WIDTH_FT) {
      console.warn(
        `[decorDemoPrice] structure charge SKIPPED: ${widthFt}ft build is at/above the ` +
          `${STRUCTURE_MIN_WIDTH_FT}ft threshold but no estimatedHeightFt was read — ` +
          `billed with ZERO structure. Re-run the read or set the height manually.`
      );
    }
    return { applies: false, fabricated: false, band: "no_height", thresholdFt: STRUCTURE_MIN_WIDTH_FT, widthFt, cost: 0 };
  }

  const areaSqFt = widthFt * heightFt;

  if (widthFt < STRUCTURE_MIN_WIDTH_FT) {
    return {
      applies: true,
      fabricated: false,
      band: "light",
      thresholdFt: STRUCTURE_MIN_WIDTH_FT,
      widthFt,
      heightFt,
      areaSqFt,
      ratePerSqFt: DECOR_STRUCTURE_RATE_LIGHT,
      cost: areaSqFt * DECOR_STRUCTURE_RATE_LIGHT,
    };
  }

  const geometry = readStructureGeometry(m.structureGeometry);
  const ratePerSqFt = STRUCTURE_RATES[geometry];
  return {
    applies: true,
    fabricated: true,
    band: "fabricated",
    thresholdFt: STRUCTURE_MIN_WIDTH_FT,
    widthFt,
    heightFt,
    areaSqFt,
    geometry,
    ratePerSqFt,
    cost: areaSqFt * ratePerSqFt,
  };
};

// Shared floral-run pricing: natural = run × rate, other tiers via divisors,
// each displayed as a ±spread range around the headroomed figure.
//
// HEADROOM APPLIES TO THE FLORAL COMPONENT ONLY. The floral rates were derived
// from actual CHARGED catalogue prices, so negotiating headroom is a genuine
// addition on top. The structure rate was derived from the founder's ₹4L
// reference for a 60×12 build — and that reference is itself a QUOTE, so it
// already contains the negotiating margin. Multiplying it again double-counts.
// The structure charge is therefore a FLAT addend: added after headroom, but
// still inside the ±spread so the client sees ONE number rather than two line
// items. It is not tier-scaled either — fabrication does not vary with the
// floral tier.
const floralRunPrices = (floralRunFt, ratePerFt, divisors, structure) => {
  const fresh = floralRunFt * ratePerFt;
  const structureCost = structure && structure.applies ? structure.cost : 0;
  const prices = {};
  Object.entries(divisors).forEach(([tier, divisor]) => {
    const centre = (fresh / divisor) * DECOR_DEMO_HEADROOM + structureCost;
    prices[tier] = {
      low: round500(centre * (1 - STAGE_RANGE_SPREAD)),
      high: round500(centre * (1 + STAGE_RANGE_SPREAD)),
    };
  });
  return prices;
};

const stageFloralPrices = (floralRunFt, structure) =>
  floralRunPrices(floralRunFt, DECOR_FLORAL_RATE_PER_FT, STAGE_TIER_DIVISORS, structure);

// ── Haldi — its own pricing MODE, not a discounted stage (founder 2026-08) ───
// Haldi setups are small events and clients spend less, so the per-foot RATE
// itself drops — not just the total. Calibration: an 8-10ft haldi backdrop is
// ₹20,000-25,000 mixed / ₹25,000-30,000 natural ≈ ₹3,000 per running floral
// foot natural (vs the Stage rate of ₹6,250), with a much tighter tier spread:
// natural ≈ 1.2× mixed where stages run 1.5×. NO ARTIFICIAL TIER — marigold
// and traditional flowers look bad artificial; the founder never offers it.
const DECOR_HALDI_RATE_PER_FT = Number(process.env.DECOR_HALDI_RATE_PER_FT) || 3000;
const HALDI_TIER_DIVISORS = { mixed: 1.2, natural: 1 }; // natural / divisor
// Typical haldi backdrop is 8-10ft (founder calibration) — the midpoint prices
// the row when no vision measurement is available (e.g. a category override).
const HALDI_DEFAULT_RUN_FT = 9;

const haldiFloralPrices = (floralRunFt, structure) =>
  floralRunPrices(floralRunFt, DECOR_HALDI_RATE_PER_FT, HALDI_TIER_DIVISORS, structure);

// Haldi is DEMO-ONLY: an occasion-priced mode with no catalog taxonomy entry,
// so its tier rule lives here beside the engine's category-aware tiers
// (Mala & More natural-only · Phoolon Ki Chadar mixed+natural · Haldi mixed+natural).
const DEMO_ONLY_TIERS = { Haldi: ["mixed", "natural"] };
const demoCategoryTiers = (category) => CATEGORY_TIERS[category] || DEMO_ONLY_TIERS[category] || null;

// ── Occasion detection (caption + vision, combined) ──────────────────────────
// Occasion was extracted-but-never-priced-on while it was only a weak
// statistical signal; haldi now carries its own RATE, so detection decides
// which pricing model applies. Detected from BOTH sources: the pin caption
// (explicit human text — wins a disagreement) and the vision model's visual
// read (used alone only when confident).
const OCCASIONS = ["haldi", "mehendi", "sangeet", "reception", "engagement", "nikah", "varmala", "muhurtham"];
const OCCASION_KEYWORDS = {
  haldi: ["haldi"],
  mehendi: ["mehendi", "mehndi", "mehandi"],
  sangeet: ["sangeet"],
  reception: ["reception"],
  engagement: ["engagement", "sagai"],
  nikah: ["nikah", "nikaah"],
  varmala: ["varmala", "jaimala", "jai mala"],
  muhurtham: ["muhurtham", "muhurtam"],
};
// Verified against Sonnet 5's distribution (2026-08): it reports 55-85% on
// detected occasions, so 0.5 still passes typical detections while blocking
// weak guesses. Unlike the measurement gates, this one did NOT need
// recalibration — occasion picks the pricing MODEL (haldi is ~2× cheaper), so
// the bar for vision-alone stays deliberately at the bottom of that range.
const OCCASION_CONF_MIN = 0.5;

const pinTextOccasionCheck = (pinText) => {
  if (!pinText || typeof pinText !== "string") return null;
  const t = pinText.toLowerCase();
  for (const [occ, words] of Object.entries(OCCASION_KEYWORDS)) {
    if (words.some((w) => t.includes(w))) return occ;
  }
  return null;
};

// resolveOccasion(pinText, visionOccasion) → { value, source, conflict }.
//   agree → that occasion (source "both") · disagree → the CAPTION, with the
//   conflict recorded for staff details · neither confident → value null (the
//   caller prices at the stage rate — the higher-revenue assumption — and says
//   so; the staff member corrects via the category dropdown).
const resolveOccasion = (pinText, visionOccasion) => {
  const caption = pinTextOccasionCheck(pinText);
  const vision =
    visionOccasion &&
    OCCASIONS.includes(visionOccasion.value) &&
    Number(visionOccasion.confidence) >= OCCASION_CONF_MIN
      ? visionOccasion.value
      : null;
  if (!caption && !vision) return { value: null, source: null, conflict: null };
  if (caption && vision && caption !== vision) {
    return { value: caption, source: "caption", conflict: { caption, vision } };
  }
  return {
    value: caption || vision,
    source: caption && vision ? "both" : caption ? "caption" : "vision",
    conflict: null,
  };
};

// ── Backdrop height model (founder 2026-08) ──────────────────────────────────
// Only three heights are ever built: 10 / 12 / 15 ft. Anything else in a
// measurement is an artifact, not a design choice — the raw sofa-count
// estimate is SNAPPED to the nearest build height, never shipped raw.
// Width sets the PRIOR (backdrops under 30ft → 10ft, 30ft+ → 12ft); the
// snapped vision estimate beats the prior unless confidence is low. 15ft ships
// only on an above-typical-confidence snap (founder: rare) and is flagged as
// unusual; below that a 15 demotes to 12 — the taller COMMON height — because
// the vision still says "tall", it just hasn't earned the rare answer.
//
// CONFIDENCE SCALE (recalibrated 2026-08 for Sonnet 5 — see the vision model
// comparison): Sonnet reports 40-60% on measurements that are CORRECT, where
// Haiku reported a falsely certain 72-80% on measurements that were wrong.
// The old gates (low 0.5 / high 0.75) sat on Haiku's scale and would have
// overridden Sonnet's correct heights with the prior on nearly every call.
// On the new scale: <0.25 = the model itself signalled it had nothing to go
// on; 0.5 = the top of Sonnet's typical range, so the rare 15ft answer must
// beat typical. Stakes are also lower than when these gates were set: height
// is ratio-derived (scale-invariant), never enters the price, and no longer
// shows on the client line — a wrong gate flips 10↔12 in staff details.
const BUILD_HEIGHTS = [10, 12, 15];
const HEIGHT_CONF_LOW = 0.25; // was 0.5 (Haiku scale) — below → trust the width prior
const HEIGHT_CONF_HIGH = 0.5; // was 0.75 (Haiku scale) — required to ship a 15ft height
const UNUSUAL_HEIGHT_NOTE = "15 ft build height — unusual (rare), verify with the client";

// Below this, the WHOLE measurement (width / floral run) is flagged low-
// confidence in the response. It still prices — Sonnet's one observed 0% came
// attached to a perfectly reasonable measurement, and the ratio method needs
// no reference object, so 0% ≠ wrong; the smoothed-ladder fallback would be
// strictly less specific. The panel surfaces a "confirm with the client"
// warning instead of silently trusting or silently discarding.
const MEASUREMENT_CONF_WARN = 0.2;

const snapBuildHeight = (raw) =>
  BUILD_HEIGHTS.reduce((best, h) => (Math.abs(h - raw) < Math.abs(best - raw) ? h : best));
const widthHeightPrior = (width) => (width >= 30 ? 12 : 10);

const resolveBackdropHeight = ({ rawHeightEstimateFt, backdropWidthFt, confidence }) => {
  const prior = widthHeightPrior(Number(backdropWidthFt) || 0);
  const raw = Number(rawHeightEstimateFt);
  const conf = Math.max(0, Math.min(1, Number(confidence) || 0));
  if (!(raw > 0) || conf < HEIGHT_CONF_LOW) {
    return { estimatedHeightFt: prior, prior, unusual: false };
  }
  const snapped = snapBuildHeight(raw);
  if (snapped === 15 && conf < HEIGHT_CONF_HIGH) {
    return { estimatedHeightFt: 12, prior, unusual: false };
  }
  return { estimatedHeightFt: snapped, prior, unusual: snapped === 15 };
};

// ── Backdrop WIDTH model (rebuilt 2026-08) ───────────────────────────────────
// The single span estimate was unreliable in BOTH directions against ground
// truth: a 10ft haldi backdrop read 16ft (+60%), a 50-60ft build read 24ft
// (-55%), and identical images re-run varied ±10%. The reasoning traces showed
// why: the model COUNTS correctly and SIZES wrongly. On the 50-60ft build it
// said "about 5 dark panels plus lanterns, roughly 24 ft wide" — 5 panels was
// right, ~5ft each was not (they are 10-12ft). Counting is discrete and has
// never failed; span estimation is continuous and always does.
//
// So width is now COMPUTED, not estimated: count × width-of-one-unit, with the
// unit judged against a reference at the SAME DEPTH (a foreground sofa against
// a distant backdrop is what compresses wide shots). The old span guess is
// demoted to `spanWidthFt` — a cross-check that never sets the answer.
//
// HEIGHT IS DELIBERATELY UNTOUCHED. It was correct 10/10/12 against ground
// truth 10/10/12, and it derives from width ÷ ratio — so re-basing it on the
// new width would silently break the one signal that works. Height therefore
// keeps deriving from the SPAN estimate (and the span sets the height prior),
// exactly as before this rebuild. Do not "tidy" these two onto one width.
const SCENE_TYPES = [
  "closeup_single_element",
  "stage_fills_frame",
  "wide_venue_shot",
  "full_venue_with_grounds",
];
// Scene type is an INDEPENDENT size sanity band — scene classification is a
// discrete choice, which the model is reliable at, and a 50-60ft build simply
// cannot be photographed close. The band a scene IMPLIES is what staff are
// shown; the band that raises a DISPUTE is the opposite one, so the 25-30ft
// zone between them stays neutral. Disputing on the implied edge instead would
// flag every reading in that zone under every scene type at once.
const NARROW_BAND_MAX_FT = 25; // closeup / fills-frame imply under this
const WIDE_BAND_MIN_FT = 30; // wide / full-venue imply over this
const SCENE_WIDTH_BANDS = {
  closeup_single_element: { maxFt: NARROW_BAND_MAX_FT },
  stage_fills_frame: { maxFt: NARROW_BAND_MAX_FT },
  wide_venue_shot: { minFt: WIDE_BAND_MIN_FT },
  full_venue_with_grounds: { minFt: WIDE_BAND_MIN_FT },
};

const readRepeatingElements = (re) => {
  if (!re) return null;
  const count = Math.round(Number(re.count));
  const each = Number(re.estimatedWidthEachFt);
  if (!(count > 0) || !(each > 0)) return null;
  const type = typeof re.type === "string" && re.type.trim() ? re.type.trim() : "units";
  return { count, type, estimatedWidthEachFt: each };
};

// CROSS-CHECK, NEVER AVERAGE. When the scene band and the computed width
// disagree we keep the computed width and RECORD the disagreement — averaging
// two disagreeing estimates yields a number that is wrong in a new way and
// hides that anything was wrong.
const sceneWidthCheck = (rawSceneType, widthFt) => {
  const sceneType = SCENE_TYPES.includes(rawSceneType) ? rawSceneType : null;
  const band = sceneType ? SCENE_WIDTH_BANDS[sceneType] : null;
  if (!band || !(widthFt > 0)) return { sceneType, sceneWidthBand: null, widthDisputed: false };
  // Fires only when the computed width lands squarely in the OTHER band — a
  // close-up that measures 40ft, or a full-venue shot that measures 24ft.
  const widthDisputed =
    band.maxFt != null ? widthFt >= WIDE_BAND_MIN_FT : widthFt <= NARROW_BAND_MAX_FT;
  return { sceneType, sceneWidthBand: band, widthDisputed };
};

// ── Floral run follows the corrected width ───────────────────────────────────
// The model judges the floral run against the width it BELIEVES, so a run in
// feet is only meaningful next to that span — pinning the run while correcting
// the width left the panel right and the quote wrong (a 50-60ft build read as
// 24ft still priced ~24ft of florals). The trustworthy signal is the COVERAGE
// FRACTION: "roughly four-fifths of this backdrop is a solid floral wall" is
// scale-invariant in exactly the way widthToHeightRatio is for height, so it
// survives a width correction that the raw foot figure cannot.
//
// Rescaling is skipped when the width was not corrected (width === span), so
// the untouched path stays bit-identical rather than picking up float drift.
const floralCoverage = (sm, reportedRun, span, width) => {
  const stored = Number(sm.floralCoverageFraction);
  const derived = span > 0 && reportedRun > 0 ? reportedRun / span : null;
  const raw = stored > 0 ? stored : derived;
  // A run reported wider than its own span is a model slip, not 120% coverage.
  const fraction = raw != null ? Math.min(1, raw) : null;
  if (fraction == null || width === span) {
    return { floralRunFt: Math.min(reportedRun, width), fraction };
  }
  // One decimal keeps the figure legible and makes the round-trip exact.
  const rescaled = Math.round(fraction * width * 10) / 10;
  return { floralRunFt: Math.min(rescaled, width), fraction };
};

// ── Structure geometry (founder 2026-08) ─────────────────────────────────────
// GEOMETRY decides the fabrication rate, NOT material identification. Founder,
// verbatim: "anywhere rounded or waves or any uneven surface is there then we
// might need FRP; block structures we do not." The model cannot reliably tell
// FRP from MDF by looking at a surface, but it reliably tells a rectilinear
// panel wall from a carved arch — so we ask it the question it can answer.
// Unknown defaults to "blocky", the cheaper and commoner of the two.
const STRUCTURE_GEOMETRIES = ["blocky", "curved_ornate"];
const readStructureGeometry = (g) => (STRUCTURE_GEOMETRIES.includes(g) ? g : "blocky");

// Defensive read of the vision measurement (also arrives client-supplied on a
// category override, so validate here, not just in the vision layer). Floral
// run can never exceed the backdrop width; height always resolves through the
// build-height model above. estimatedHeightFt is the snapped, price-driving
// value; rawHeightEstimateFt is kept for staff details / drift debugging.
// The returned object is designed to ROUND-TRIP through this function: the
// panel resends it verbatim on a category override.
const readStageMeasurements = (sm) => {
  if (!sm) return null;
  // The span guess. New payloads send it as spanWidthFt; older ones (and a
  // resent pre-rebuild measurement) only have backdropWidthFt, which WAS the
  // span estimate — so falling back to it keeps those heights identical too.
  const spanRaw = Number(sm.spanWidthFt);
  const span = spanRaw > 0 ? spanRaw : Number(sm.backdropWidthFt);
  const repeating = readRepeatingElements(sm.repeatingElements);
  // count × width-each is the answer; the span only stands in when there is no
  // usable unit count at all.
  const width = repeating ? repeating.count * repeating.estimatedWidthEachFt : span;
  const run = Number(sm.floralRunFt);
  if (!(width > 0) || !(run > 0)) return null;
  const confidence = Math.max(0, Math.min(1, Number(sm.confidence) || 0));
  // The width:height ratio of the STRUCTURE is the primary height signal —
  // scale-invariant, so it can't repeat the whole-image sofa-scaling failure
  // (a sofa at 1/6 of FRAME height read as an 18ft build on an 11ft backdrop).
  // When a ratio is present the raw height is re-derived here deterministically;
  // the model's own sofa-scaled figure survives only when no ratio came back.
  const ratio = Number(sm.widthToHeightRatio);
  // HEIGHT STAYS ON THE SPAN (see the width-model note above): the 10/10/12
  // ground-truth match came from span ÷ ratio, and the width rebuild must not
  // move it. Only when there is no span at all does the computed width stand in.
  const heightBasisWidth = span > 0 ? span : width;
  const rawHeight = ratio > 0 ? heightBasisWidth / ratio : Number(sm.rawHeightEstimateFt);
  let reasoning = typeof sm.reasoning === "string" ? sm.reasoning : "";
  let estimatedHeightFt;
  if (rawHeight > 0) {
    const resolved = resolveBackdropHeight({ rawHeightEstimateFt: rawHeight, backdropWidthFt: heightBasisWidth, confidence });
    estimatedHeightFt = resolved.estimatedHeightFt;
    if (resolved.unusual && !reasoning.includes(UNUSUAL_HEIGHT_NOTE)) {
      reasoning = reasoning ? `${reasoning} · ${UNUSUAL_HEIGHT_NOTE}` : UNUSUAL_HEIGHT_NOTE;
    }
  } else {
    // No raw estimate (e.g. an older resent payload): accept only a real build
    // height, otherwise fall back to the width prior.
    const h = Number(sm.estimatedHeightFt);
    estimatedHeightFt = BUILD_HEIGHTS.includes(h) ? h : widthHeightPrior(heightBasisWidth);
  }
  const scene = sceneWidthCheck(sm.sceneType, width);
  const coverage = floralCoverage(sm, run, span, width);
  return {
    backdropWidthFt: width,
    // How the width was arrived at, and both of the signals that were weighed
    // against it — the panel shows the working so staff can correct it at a
    // glance ("those panels are 12 ft"), which a bare "24 ft" never allows.
    widthBasis: repeating ? "repeating-elements" : "span",
    repeatingElements: repeating,
    spanWidthFt: span > 0 ? span : null,
    sceneType: scene.sceneType,
    sceneWidthBand: scene.sceneWidthBand,
    widthDisputed: scene.widthDisputed,
    structureGeometry: readStructureGeometry(sm.structureGeometry),
    floralRunFt: coverage.floralRunFt,
    // The FRACTION is the durable signal, not the foot figure — stored so a
    // resent measurement rescales from the original fraction instead of
    // re-dividing an already-rescaled run by the span (which would compound).
    floralCoverageFraction: coverage.fraction,
    estimatedHeightFt,
    rawHeightEstimateFt: rawHeight > 0 ? rawHeight : null,
    widthToHeightRatio: ratio > 0 ? ratio : null,
    reasoning,
    confidence,
    // Near-zero confidence: the measurement still prices, but flagged so the
    // panel warns staff to confirm sizes rather than silently trusting it.
    lowConfidence: confidence < MEASUREMENT_CONF_WARN,
  };
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
  const occasion = opts.occasion || null;

  // Rejection escape hatch — not a décor product → no pricing.
  if (!analysis || analysis.isDecorProduct === false) {
    const reason =
      (analysis && analysis.complexity && analysis.complexity.reasoning) ||
      "This image doesn't look like a décor product.";
    return { rejected: true, reason };
  }

  // A haldi occasion re-labels a Stage: same visual category, different
  // pricing MODEL (the haldi rate). Only Stage flips — a haldi caption on a
  // Mandap is surfaced but does not change the model. The panel's category
  // dropdown (which now lists Haldi) is the correction path in both
  // directions: overrides skip occasion resolution entirely.
  const detectedCategory = analysis.category;
  const category =
    detectedCategory === "Stage" && occasion && occasion.value === "haldi" ? "Haldi" : detectedCategory;
  const tiers = demoCategoryTiers(category);
  if (!tiers) {
    return {
      rejected: true,
      reason: `Not a priceable décor category${category ? ` (${category})` : ""}.`,
    };
  }

  const comps = Array.isArray(comparables) ? comparables : [];
  const bandTier = bandTierOf(tiers);
  const floralRunCategory = category === "Stage" || category === "Haldi";
  const stageMeasurements = floralRunCategory ? readStageMeasurements(analysis.stageMeasurements) : null;
  // Structure charge — light band under 30ft, fabrication at/over it.
  // Haldi is EXEMPT at any width (see structureCharge): it used to be a no-op
  // here purely because haldi backdrops are 8-10ft and the old rule charged
  // nothing under 30ft. The light band removed that accident, so the exemption
  // now has to be stated explicitly.
  const structure = structureCharge(stageMeasurements, { fabricationExempt: category === "Haldi" });
  // Measured Stage replaces the size ladder with one floral-run price block.
  const buckets = stageMeasurements ? null : SIZE_BUCKETS[category];
  const sized = !!buckets;
  const withImage = comps.filter((c) => c && c.image);

  let ladder;
  let anchor = null;
  // ── PRESENTATION FLAG (2026-08-17) ────────────────────────────────────────
  // Set by the branch that ACTUALLY PRICED, so it cannot drift from the pricing
  // decision. The panel gates five presentation features on this: the
  // measurement line, the disputed-width warning, the confirm-the-size-with-the
  // -client note, the hint text, and the staff floral-rate line.
  //
  // It exists because the client CANNOT infer this from the response. The wire
  // carries `stageMeasurements` for ANY category (see the note at the return
  // below — that is deliberate, so the panel can resend a measurement with a
  // category override), while only Stage-with-a-measurement and Haldi are
  // actually priced by floral run. Presence of measurements therefore does not
  // imply floral-run pricing, and `pricingModel` is correctly stripped at the
  // wire as pricing METHOD. Hence one explicit boolean.
  let floralRunPriced = false;
  if (category === "Haldi") {
    // Haldi always prices by floral run at its own rate; without a vision
    // measurement it falls back to the typical 8-10ft backdrop (9ft midpoint)
    // rather than dying — the founder's calibration band IS the default answer.
    const run = stageMeasurements ? stageMeasurements.floralRunFt : HALDI_DEFAULT_RUN_FT;
    const row = { size: null, prices: haldiFloralPrices(run, structure) };
    if (includeExamples) {
      row.examplesAtThisSize = withImage.slice(0, 3).map((c) => exampleOf(c, bandTier));
    }
    ladder = [row];
    // Haldi is ALWAYS floral-run priced — even with no vision measurement, where
    // it falls back to the 9ft default run above. So this is true regardless of
    // whether stageMeasurements exists.
    floralRunPriced = true;
  } else if (stageMeasurements) {
    const row = { size: null, prices: stageFloralPrices(stageMeasurements.floralRunFt, structure) };
    if (includeExamples) {
      row.examplesAtThisSize = withImage.slice(0, 3).map((c) => exampleOf(c, bandTier));
    }
    ladder = [row];
    floralRunPriced = true;
  } else if (sized) {
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
    // Vision size signals for the panel: informational only — the min-width
    // estimate and best-fit badge NEVER remove rows (staff cannot quote a row
    // that is not there) and never move a price.
    minBuildWidth: analysis.minBuildWidth || null,
    recommendedSize: analysis.recommendedSize || null,
    // The vision backdrop measurement, echoed whatever the category so the
    // panel can resend it with a category override to Stage.
    // ⚠️ DELIBERATELY UNGATED — unlike the `stageMeasurements` LOCAL above,
    // which is gated to Stage|Haldi (:677) and is what actually drove pricing.
    // So the wire can carry measurements on a build that was priced by the size
    // ladder. That is why the panel cannot infer floral-run pricing from this
    // field's presence, and why `floralRunPriced` below exists.
    stageMeasurements: readStageMeasurements(analysis.stageMeasurements),
    // The fabrication breakdown is STAFF-DETAILS material only — the client
    // sees one combined "estimated build" figure, never floral and structure
    // as two line items. Present (with applies:false) even below the 30ft
    // threshold, so staff details can say which side of it the build fell on.
    structure,
    // Detected occasion — visible and correctable in the panel. When nothing
    // was confident on a Stage, the stage rate applied by default and we SAY so.
    ...(occasion
      ? {
          occasion: {
            value: occasion.value,
            source: occasion.source,
            conflict: occasion.conflict,
            ...(category === "Stage" && !occasion.value ? { defaultedToStageRate: true } : {}),
          },
        }
      : {}),
    // The ONE presentation boolean the panel gates its floral-run UI on. Carries
    // no rate, no multiplier and no method name — just "was this priced by
    // floral run?". Sourced from the branch that priced (see above), never from
    // analysis.stageMeasurements.
    floralRunPriced,
    // The per-foot rate rides along so staff details can show the arithmetic
    // behind the single combined figure, not just its result. STRIPPED at the
    // wire — method, not output. Keyed off the same flag so the two can never
    // disagree about which model priced the build.
    ...(floralRunPriced
      ? {
          pricingModel: "floral-run",
          floralRatePerFt: category === "Haldi" ? DECOR_HALDI_RATE_PER_FT : DECOR_FLORAL_RATE_PER_FT,
        }
      : {}),
    applicableTiers: tiers,
    sized,
    upliftApplied: 1, // the ×1.20 draft-path uplift never applies to the demo
    headroomApplied: DECOR_DEMO_HEADROOM, // negotiating headroom baked into every figure
    ...(anchor ? { anchor: { size: anchor.size, priceBasis: anchor.priceBasis, comparablesUsed: anchor.comparablesUsed } } : {}),
    ladder,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// buildStorePrice(decorDoc, { analysis }) — the pin is ALREADY A PRODUCT.
//
// Step (a) of the read-cache lookup order (2026-08-17). When a pin resolves to
// an approved draft with a live published product, the panel must show THAT
// PRODUCT'S PRICE, not an AI estimate of it: a human set that number and it is
// what the store will actually charge. It also means a catalogue price edit is
// reflected immediately — the deliberate exception to "a revisit must not
// differ", because there the new number IS the wanted answer.
//
// Emits the same response contract as buildDemoPrice so the panel needs no
// second renderer: one ladder row, tier prices as a POINT (low === high — a
// store price is not a range), and no headroom arithmetic anywhere near it.
// `comparables` is deliberately not a parameter: nothing here is estimated.
//
// The cached vision read, when we have one, contributes ONLY its descriptive
// fields (observations, measurements) so the panel keeps its measurement line.
// It never touches the price.
// ─────────────────────────────────────────────────────────────────────────────
const buildStorePrice = (decorDoc, { analysis } = {}) => {
  const doc = decorDoc || {};
  const category = doc.category || "";
  const tiers = demoCategoryTiers(category);
  const info = doc.productInfo || {};
  const m = info.measurements || {};

  // Live selling prices off productTypes, per tier — the same mapping the
  // comparable normaliser uses, so a tier is named the same way everywhere.
  const prices = {};
  (Array.isArray(doc.productTypes) ? doc.productTypes : []).forEach((pt) => {
    if (!pt) return;
    const tier = tierOf(pt.name);
    const price = Number(pt.sellingPrice);
    if (Number.isFinite(price) && price > 0 && (prices[tier] === undefined || price > prices[tier])) {
      prices[tier] = price;
    }
  });

  const sizeLabel =
    Number(m.length) > 0 && Number(m.width) > 0 ? `${Number(m.length)}x${Number(m.width)}` : null;

  return {
    rejected: false,
    category,
    // Not a guess — a human classified this product on approval.
    categoryConfidence: 1,
    observations: Array.isArray(analysis && analysis.observations) ? analysis.observations : [],
    minBuildWidth: (analysis && analysis.minBuildWidth) || null,
    recommendedSize: sizeLabel,
    stageMeasurements: readStageMeasurements(analysis && analysis.stageMeasurements),
    // No structure charge and no floral-run model: nothing was estimated.
    floralRunPriced: false,
    applicableTiers: tiers || Object.keys(prices),
    sized: false,
    upliftApplied: 1,
    headroomApplied: 1, // the store price already is what we charge
    ladder: [
      {
        size: sizeLabel,
        prices: Object.fromEntries(Object.entries(prices).map(([t, p]) => [t, { low: p, high: p }])),
      },
    ],
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
  buildStorePrice,
  pinTextCategoryCheck,
  SIZE_BUCKETS,
  DECOR_DEMO_HEADROOM,
  DEMO_TIER_LADDER,
  REFERENCE_SIZE,
  DECOR_AREA_EXPONENT,
  DECOR_FLORAL_RATE_PER_FT,
  STAGE_TIER_DIVISORS,
  STAGE_RANGE_SPREAD,
  DECOR_HALDI_RATE_PER_FT,
  HALDI_TIER_DIVISORS,
  HALDI_DEFAULT_RUN_FT,
  demoCategoryTiers,
  OCCASIONS,
  pinTextOccasionCheck,
  resolveOccasion,
  stageFloralPrices,
  haldiFloralPrices,
  readStageMeasurements,
  structureCharge,
  STRUCTURE_MIN_WIDTH_FT,
  STRUCTURE_RATES,
  STRUCTURE_GEOMETRIES,
  DECOR_STRUCTURE_RATE_STEEL,
  DECOR_STRUCTURE_RATE_FRP,
  DECOR_STRUCTURE_RATE_LIGHT,
  sceneWidthCheck,
  SCENE_TYPES,
  SCENE_WIDTH_BANDS,
  resolveBackdropHeight,
  BUILD_HEIGHTS,
  HEIGHT_CONF_LOW,
  HEIGHT_CONF_HIGH,
  MEASUREMENT_CONF_WARN,
};
