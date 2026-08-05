// Demo-price ladder tests. Run: node tests/decor-demo-price.test.js
// PURE (no DB, no vision): drives buildDemoPrice with a synthetic Phase B
// analysis + comparables. Covers a flat-price category, a natural-only category,
// a Stage full ladder, and a non-décor rejection — plus category-aware tiers,
// the negotiating anchor (p75 × headroom, low = high × 0.8), the founder's
// Mandap ladder, examplesAtThisSize, and the pin-text cross-check.
const {
  buildDemoPrice,
  pinTextCategoryCheck,
  SIZE_BUCKETS,
  DECOR_FLORAL_RATE_PER_FT,
  STAGE_TIER_DIVISORS,
  DECOR_HALDI_RATE_PER_FT,
  HALDI_TIER_DIVISORS,
  demoCategoryTiers,
  pinTextOccasionCheck,
  resolveOccasion,
  readStageMeasurements,
  resolveBackdropHeight,
} = require("../services/decorDemoPrice");
const { normalizeComparable } = require("../services/decorPricing");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${got} vs ${want})`);
// Tier prices are RANGES ({low, high}): low = anchored figure (p75 of the live
// naturals × 1.15 headroom, laddered per tier), high = low / 0.8, ₹500-rounded.
const range = (got, low, high, label) =>
  ok(got != null && got.low === low && got.high === high, `${label} (${JSON.stringify(got)} vs ${low}–${high})`);

const analysis = (category, extra = {}) => ({ isDecorProduct: true, category, categoryConfidence: 0.9, ...extra });
const doc = (id, name, tiers, size) => normalizeComparable({
  name,
  image: `https://cdn/${id}.jpg`,
  productInfo: { id, measurements: size ? { length: size[0], width: size[1] } : {} },
  productTypes: Object.entries(tiers).map(([n, sellingPrice]) => ({ name: n, sellingPrice })),
});

// ── 1. Flat-price category (Partitions) ──────────────────────────────────────
{
  console.log("Partitions (flat):");
  const comps = [
    doc("pt1", "A", { Price: 15000 }), doc("pt2", "B", { Price: 20000 }),
    doc("pt3", "C", { Price: 20000 }), doc("pt4", "D", { Price: 25000 }),
  ];
  const r = buildDemoPrice(analysis("Partitions"), comps);
  eq(r.rejected, false, "not rejected");
  eq(r.sized, false, "no size ladder");
  eq(r.ladder.length, 1, "single category-band row");
  eq(r.ladder[0].size, null, "row has no size");
  eq(JSON.stringify(r.applicableTiers), JSON.stringify(["flat"]), "flat tier only");
  range(r.ladder[0].prices.flat, 24500, 30500, "flat anchored on p75 (21250) × 1.15, high = low / 0.8");
  eq(r.ladder[0].prices.natural, undefined, "no natural tier on a flat category");
  eq(r.upliftApplied, 1, "no draft-path uplift");
  eq(r.headroomApplied, 1.15, "negotiating headroom reported");
}

// ── 2. Natural-only category (Mala & More) ───────────────────────────────────
{
  console.log("Mala & More (natural only):");
  const comps = [
    doc("na1", "A", { Natural: 8000 }), doc("na2", "B", { Natural: 8000 }),
    doc("na3", "C", { Natural: 8000 }), doc("na4", "D", { Natural: 12000 }),
  ];
  const r = buildDemoPrice(analysis("Mala & More"), comps);
  eq(r.sized, false, "no size ladder");
  eq(JSON.stringify(r.applicableTiers), JSON.stringify(["natural"]), "natural tier only");
  range(r.ladder[0].prices.natural, 10500, 13000, "natural anchored on p75 (9000) × 1.15");
  eq(r.ladder[0].prices.artificial, undefined, "no artificial tier");
  eq(r.ladder[0].prices.mixed, undefined, "no mixed tier");
}

// ── 3. Stage — ladder SMOOTHED from the 24x16 reference anchor ───────────────
{
  console.log("Stage (smoothed ladder from the 24x16 reference):");
  const comps = [
    doc("st_a", "SA", { "Natural Flowers": 40000 }, [16, 12]), // examples only — never price a row directly
    doc("st_b", "SB", { "Natural Flowers": 50000 }, [16, 12]),
    doc("st_c", "SC", { "Natural Flowers": 90000 }, [24, 16]), // the reference comp
    doc("st108", "OUT", { "Natural Flowers": 300000 }, [24, 16]), // premium OUTLIER at the reference size
  ];
  const r = buildDemoPrice(analysis("Stage"), comps, { includeExamples: true });
  eq(r.sized, true, "Stage is size-laddered");
  eq(r.ladder.length, SIZE_BUCKETS.Stage.length, "one row per Stage bucket (8)");
  eq(JSON.stringify(r.applicableTiers), JSON.stringify(["artificial", "mixed", "natural"]), "all three tiers");
  eq(r.anchor.size, "24x16", "anchored on the Stage reference size");
  eq(r.anchor.priceBasis, "live", "reference anchored on live comparables");
  eq(r.anchor.comparablesUsed, 1, "premium outlier st108 excluded from the reference anchor");

  const row2416 = r.ladder.find((x) => x.size === "24x16");
  range(row2416.prices.natural, 103500, 129500, "24x16 (reference) natural = 90000 × 1.15");
  range(row2416.prices.artificial, 72000, 90000, "24x16 artificial = natural anchor / 1.44 (Stage ladder)");

  const row1612 = r.ladder.find((x) => x.size === "16x12");
  range(row1612.prices.natural, 53500, 67000, "16x12 natural = reference × (192/384)^0.95");
  range(row1612.prices.artificial, 37000, 46500, "16x12 artificial via Stage ladder");
  ok(!("premiumCeiling" in row1612), "premiumCeiling stays removed");

  const row1616 = r.ladder.find((x) => x.size === "16x16");
  range(row1616.prices.natural, 70500, 88000, "16x16 natural sits ABOVE 16x12 (smoothing fixed the inversion)");

  const row3016 = r.ladder.find((x) => x.size === "30x16");
  range(row3016.prices.natural, 128000, 160000, "30x16 natural = reference × (480/384)^0.95");
  const ratio = row3016.prices.natural.low / row2416.prices.natural.low;
  ok(ratio > 1.2 && ratio < 1.25, `30x16 is ~24% above 24x16 (founder: 20-25%) — got ${ratio.toFixed(3)}`);

  const row4020 = r.ladder.find((x) => x.size === "40x20");
  range(row4020.prices.natural, 208000, 260000, "40x20 smoothed too — no more per-bucket cliff");

  const byArea = r.ladder.slice().sort((a, b) => a.area - b.area);
  ok(
    byArea.every((row, i) => i === 0 || row.prices.natural.low > byArea[i - 1].prices.natural.low),
    "natural price increases MONOTONICALLY with area across all 8 rows"
  );
  ok(!("pricingModel" in r), "no vision measurement → Stage stays on the area-ladder fallback");

  // examplesAtThisSize: scale/price-point proof, bucketed by nearest size.
  ok(Array.isArray(row1612.examplesAtThisSize), "16x12 row has examplesAtThisSize array");
  ok(row1612.examplesAtThisSize[0].image === "https://cdn/st_a.jpg", "example carries an image URL");
  eq(row2416.examplesAtThisSize[0] && row2416.examplesAtThisSize[0].productCode, "st_c", "24x16 example is the 384-bucket product");
  ok(!("similar" in row1612) && !("matches" in row1612), "field is examplesAtThisSize, not similar/matches");
}

// ── 3b. Mandap — lookup-anchored reference smooths every row ─────────────────
{
  console.log("Mandap (12x12 reference falls back to lookup, rows smoothed):");
  // No comparables at the 12x12 reference → the engine size lookup (₹64,000)
  // anchors the ladder; 15x15 comps no longer price their own row directly.
  const comps = [
    doc("ma_x", "MX", { "Natural Flowers": 150000 }, [15, 15]),
    doc("ma_y", "MY", { "Natural Flowers": 150000 }, [15, 15]),
  ];
  const r = buildDemoPrice(analysis("Mandap"), comps);
  eq(r.anchor.size, "12x12", "anchored on the Mandap reference size");
  eq(r.anchor.priceBasis, "lookup", "no live comps at 12x12 → engine lookup anchors");
  range(r.ladder.find((x) => x.size === "12x12").prices.natural, 73500, 92000, "12x12 natural = lookup 64000 × 1.15");
  const row = r.ladder.find((x) => x.size === "15x15");
  range(row.prices.natural, 112500, 140500, "15x15 natural = reference × (225/144)^0.95");
  range(row.prices.artificial, 62500, 78000, "15x15 artificial = natural / 1.8 (founder Mandap ladder)");
  const byArea = r.ladder.slice().sort((a, b) => a.area - b.area);
  ok(
    byArea.every((x, i) => i === 0 || x.prices.natural.low > byArea[i - 1].prices.natural.low),
    "Mandap natural price increases monotonically with area"
  );
}

// ── 3c. Mandap 12x12 — the founder's verification figures, exactly ───────────
{
  console.log("Mandap 12x12 (founder verification: real price 50/70/90k):");
  const comps = [doc("ma_std", "Standard Mandap", { "Natural Flowers": 90000 }, [12, 12])];
  const r = buildDemoPrice(analysis("Mandap"), comps);
  eq(r.anchor.size, "12x12", "12x12 IS the Mandap reference — figures survive smoothing");
  const row = r.ladder.find((x) => x.size === "12x12");
  range(row.prices.artificial, 57500, 72000, "Artificial ₹57,500 – 72,000");
  range(row.prices.mixed, 80500, 100500, "Mixed ₹80,500 – 1,00,500");
  range(row.prices.natural, 103500, 129500, "Fresh ₹1,03,500 – 1,29,500");
}

// ── 3e. Stage floral-run pricing — founder calibration points ────────────────
{
  console.log("Stage floral-run (founder calibration):");
  // Calibration point 1 — 24ft fully floral, pre-headroom bases within 5%:
  // Fresh ₹1,50,000 · Mixed ₹1,00,000 · Artificial ₹75,000.
  const fresh24 = 24 * DECOR_FLORAL_RATE_PER_FT;
  ok(Math.abs(fresh24 - 150000) / 150000 <= 0.05, `24ft fresh base ₹${fresh24} within 5% of ₹1,50,000`);
  const art24 = fresh24 / STAGE_TIER_DIVISORS.artificial;
  ok(art24 >= 65000 && art24 <= 85000, `24ft artificial base ₹${art24} inside founder range 65-85k`);
  const mix24 = fresh24 / STAGE_TIER_DIVISORS.mixed;
  ok(mix24 >= 90000 && mix24 <= 120000, `24ft mixed base ₹${Math.round(mix24)} inside founder range 90-120k`);
  // Calibration point 2 — the founder's garland-and-clusters example:
  // ~12.5 running feet of true floral → fresh near ₹78,000.
  const fresh125 = 12.5 * DECOR_FLORAL_RATE_PER_FT;
  ok(Math.abs(fresh125 - 78000) / 78000 <= 0.05, `12.5ft fresh base ₹${fresh125} within 5% of ₹78,000`);

  // End to end: solid 24ft wall → one price block, ±7% around headroomed base.
  const solid = buildDemoPrice(
    analysis("Stage", {
      stageMeasurements: { backdropWidthFt: 24, floralRunFt: 24, estimatedHeightFt: 12, reasoning: "solid floral wall, five sofas across", confidence: 0.85 },
    }),
    []
  );
  eq(solid.pricingModel, "floral-run", "measured Stage prices by floral run");
  eq(solid.sized, false, "no size ladder for a measured Stage");
  eq(solid.ladder.length, 1, "single measured price block");
  range(solid.ladder[0].prices.natural, 160500, 184500, "fresh = 150000 × 1.15 headroom, ±7%");
  range(solid.ladder[0].prices.mixed, 107000, 123000, "mixed = fresh/1.5 (Stage divisor, not the Mandap ladder)");
  range(solid.ladder[0].prices.artificial, 80000, 92500, "artificial = fresh/2");
  eq(solid.stageMeasurements.floralRunFt, 24, "measurements echoed in the response");

  // Same 24ft backdrop, garland + clusters → half the price at 12.5 floral ft.
  const garland = buildDemoPrice(
    analysis("Stage", {
      stageMeasurements: { backdropWidthFt: 24, floralRunFt: 12.5, estimatedHeightFt: 12, reasoning: "top garland and side clusters ≈ 12-13 ft", confidence: 0.8 },
    }),
    []
  );
  range(garland.ladder[0].prices.natural, 83500, 96000, "12.5 floral ft fresh ≈ ₹78k base, headroomed ±7%");
  ok(
    garland.ladder[0].prices.natural.high < solid.ladder[0].prices.natural.low,
    "same width, garland-only build prices well below the solid wall"
  );

  // Guards: floral run can't exceed the backdrop; a missing height estimate
  // falls back to the width prior (20ft backdrop → 10ft).
  const capped = readStageMeasurements({ backdropWidthFt: 20, floralRunFt: 26, confidence: 0.9 });
  eq(capped.floralRunFt, 20, "floral run capped at backdrop width");
  eq(capped.estimatedHeightFt, 10, "missing height → width prior (under 30ft → 10ft)");
  eq(readStageMeasurements({ backdropWidthFt: 0, floralRunFt: 5 }), null, "invalid width → no measurement");
}

// ── 3g. Height model — snapped to the three real build heights (10/12/15) ────
// Gate inputs use SONNET's confidence scale (recalibrated 2026-08): correct
// measurements report ~40-60%, so 0.45 is "typical good", 0.55 is
// above-typical, and 0.2 is the model signalling it had nothing to go on.
{
  console.log("backdrop height model (snap 10/12/15, width prior, confidence gates):");
  const h = (raw, width, conf) =>
    resolveBackdropHeight({ rawHeightEstimateFt: raw, backdropWidthFt: width, confidence: conf }).estimatedHeightFt;

  // Nearest-neighbour snapping on the raw sofa-count estimate.
  eq(h(8, 24, 0.45), 10, "8ft raw snaps to 10");
  eq(h(13, 36, 0.45), 12, "13ft raw snaps to 12");
  eq(h(11.5, 24, 0.45), 12, "11.5ft raw snaps to 12");
  eq(h(15, 36, 0.55), 15, "genuinely-tall 15ft ships at above-typical confidence (≥0.5)");
  ok(
    resolveBackdropHeight({ rawHeightEstimateFt: 15, backdropWidthFt: 36, confidence: 0.55 }).unusual,
    "a shipped 15ft is flagged unusual (founder: rare)"
  );

  // Width prior wins only when the model signalled no basis (<0.25); Sonnet's
  // typical 40-60% readings must NOT be overridden — they were the correct ones.
  eq(h(12, 24, 0.2), 10, "near-zero confidence → width prior (24ft backdrop → 10ft)");
  eq(h(15, 36, 0.2), 12, "near-zero confidence → width prior (36ft backdrop → 12ft)");
  eq(h(12, 24, 0.45), 12, "Sonnet-typical confidence beats the 10ft prior (old 0.5 gate would have overridden this)");
  eq(h(0, 24, 0.9), 10, "no raw estimate → width prior regardless of confidence");

  // A 15 below above-typical confidence demotes to 12 (the taller COMMON height).
  eq(h(15, 36, 0.45), 12, "15 at typical confidence demotes to 12");

  // REGRESSION — the panel-backdrop pins: Haiku claimed ~15ft raw with
  // falsely-certain 0.7-0.8 confidence on founder-confirmed 10ft builds. The
  // primary protection is now ratio-first derivation (3h below) plus the model
  // swap itself — Sonnet returned 10/12 across all nine comparison images and
  // reports ~0.4-0.6 when right. On the recalibrated scale, an untrustworthy
  // tall claim arrives at ≤ typical confidence and must land 10-12, never 15.
  const regTypical = h(15, 24, 0.45);
  ok(regTypical === 12, `tall claim @ typical confidence lands 12 (got ${regTypical})`);
  const regNoBasis = h(15, 24, 0.2);
  ok(regNoBasis === 10, `tall claim @ near-zero confidence lands on the 10ft prior (got ${regNoBasis})`);
  ok(regTypical !== 15 && regNoBasis !== 15, "a below-above-typical tall claim can never ship 15");

  // readStageMeasurements carries raw + snapped + the unusual note (once).
  const m15 = readStageMeasurements({
    backdropWidthFt: 36, floralRunFt: 20, rawHeightEstimateFt: 14.5, confidence: 0.9, reasoning: "five sofa-heights",
  });
  eq(m15.estimatedHeightFt, 15, "14.5 raw @ high confidence snaps to 15");
  eq(m15.rawHeightEstimateFt, 14.5, "raw estimate preserved for staff details");
  ok(m15.reasoning.includes("unusual"), "unusual flag appended to reasoning");
  const again = readStageMeasurements(m15);
  eq(again.reasoning.split("unusual").length - 1, 1, "re-validation doesn't duplicate the unusual note");

  // ── Height from width:height ratio — structure-only measurement ────────────
  // FOUNDER REGRESSION — second panel-backdrop pin: whole-image sofa scaling
  // claimed ~18ft (the sofa was ~1/6 of FRAME height, 6 × 3ft) where the
  // structure itself is only ~60% of the frame. A ~30ft backdrop at roughly
  // 3:1 must derive ~10ft and snap to 10 — not 15.
  const reg3 = readStageMeasurements({
    backdropWidthFt: 30,
    floralRunFt: 18,
    widthToHeightRatio: 3,
    rawHeightEstimateFt: 18, // the bad whole-image sofa figure — must be ignored
    confidence: 0.8,
    reasoning: "about 3x wider than tall",
  });
  eq(reg3.rawHeightEstimateFt, 10, "raw height re-derived from width/ratio (30/3) — sofa-scaled 18ft ignored");
  eq(reg3.estimatedHeightFt, 10, "founder case snaps to 10, not 15");
  eq(reg3.widthToHeightRatio, 3, "ratio carried in the measurement for staff visibility");
  const reg3again = readStageMeasurements(reg3);
  eq(reg3again.estimatedHeightFt, 10, "re-validation (override resend) stays at 10");

  // Ratio at near-zero confidence still falls back to the width prior.
  eq(
    readStageMeasurements({ backdropWidthFt: 30, floralRunFt: 18, widthToHeightRatio: 3, confidence: 0.2 }).estimatedHeightFt,
    12,
    "near-zero confidence → width prior (30ft → 12), ratio notwithstanding"
  );

  // 0% confidence handled EXPLICITLY: the measurement still prices (Sonnet's
  // observed 0% came with a reasonable measurement; the fallback ladder would
  // be less specific) but is flagged so the panel warns staff.
  const zeroConf = readStageMeasurements({ backdropWidthFt: 10, floralRunFt: 8, widthToHeightRatio: 2.5, confidence: 0 });
  eq(zeroConf.lowConfidence, true, "0% confidence → lowConfidence flag set");
  eq(zeroConf.floralRunFt, 8, "0% confidence measurement is kept, not discarded");
  eq(zeroConf.estimatedHeightFt, 10, "0% confidence height falls to the width prior");
  const typicalConf = readStageMeasurements({ backdropWidthFt: 10, floralRunFt: 8, widthToHeightRatio: 2.5, confidence: 0.45 });
  eq(typicalConf.lowConfidence, false, "Sonnet-typical confidence is not flagged");
  const zeroPriced = buildDemoPrice(analysis("Stage", { stageMeasurements: zeroConf }), []);
  eq(zeroPriced.pricingModel, "floral-run", "0% confidence still prices by floral run");
  eq(zeroPriced.stageMeasurements.lowConfidence, true, "flag reaches the panel response");

  // No ratio returned → the sofa estimate still drives, as before.
  const noRatio = readStageMeasurements({ backdropWidthFt: 24, floralRunFt: 12, rawHeightEstimateFt: 11.4, confidence: 0.8 });
  eq(noRatio.rawHeightEstimateFt, 11.4, "no ratio → sofa estimate kept");
  eq(noRatio.estimatedHeightFt, 12, "11.4ft raw snaps to 12");
  eq(noRatio.widthToHeightRatio, null, "absent ratio stays null, never fabricated");

  // A very wide 4:1 build still lands on a real build height (24/4 = 6 → 10).
  eq(
    readStageMeasurements({ backdropWidthFt: 24, floralRunFt: 24, widthToHeightRatio: 4, confidence: 0.8 }).estimatedHeightFt,
    10,
    "4:1 ratio derives 6ft raw → snaps to the 10ft build height"
  );

  // CALIBRATION RE-RUN at the 10ft snapped height — figures must not move.
  const solid10 = buildDemoPrice(
    analysis("Stage", {
      stageMeasurements: { backdropWidthFt: 24, floralRunFt: 24, rawHeightEstimateFt: 9, confidence: 0.85, reasoning: "solid wall" },
    }),
    []
  );
  eq(solid10.stageMeasurements.estimatedHeightFt, 10, "9ft raw on a 24ft backdrop → 10ft snapped");
  range(solid10.ladder[0].prices.natural, 160500, 184500, "₹1,50,000 calibration holds at 10ft height");
  const garland10 = buildDemoPrice(
    analysis("Stage", {
      stageMeasurements: { backdropWidthFt: 24, floralRunFt: 12.5, rawHeightEstimateFt: 9, confidence: 0.85, reasoning: "garland + clusters" },
    }),
    []
  );
  range(garland10.ladder[0].prices.natural, 83500, 96000, "₹78,000 calibration holds at 10ft height");
}

// ── 3i. Width model — COUNTED, cross-checked against the scene, never averaged ─
// Ground-truth failures this replaces: a 10ft haldi backdrop read 16ft (+60%),
// a 50-60ft build read 24ft (-55%), two 60ft renders read 24ft and 30ft.
{
  console.log("backdrop width model (count × width-each, scene cross-check):");
  const base = { floralRunFt: 20, confidence: 0.6 };

  // The headline case: the model counted 5 panels correctly and sized them at
  // ~5ft when they are 10-12ft. The count is what we price on now.
  const counted = readStageMeasurements({
    ...base,
    spanWidthFt: 24,
    repeatingElements: { count: 5, type: "panels", estimatedWidthEachFt: 11 },
    sceneType: "full_venue_with_grounds",
  });
  eq(counted.backdropWidthFt, 55, "width = count × width-each, not the span guess");
  eq(counted.widthBasis, "repeating-elements", "basis recorded");
  eq(counted.spanWidthFt, 24, "the demoted span guess is kept, not discarded");
  eq(counted.widthDisputed, false, "55ft agrees with a full-venue shot (over ~30ft)");

  // No repeating unit at all → the span stands in, and says so.
  const spanOnly = readStageMeasurements({ ...base, spanWidthFt: 18, sceneType: "stage_fills_frame" });
  eq(spanOnly.backdropWidthFt, 18, "no unit count → span is the fallback");
  eq(spanOnly.widthBasis, "span", "fallback basis recorded");
  eq(spanOnly.repeatingElements, null, "absent unit count stays null, never fabricated");

  // A single continuous floral wall is count=1 — still the counted path.
  eq(
    readStageMeasurements({ ...base, spanWidthFt: 16, repeatingElements: { count: 1, type: "wall", estimatedWidthEachFt: 12 } })
      .backdropWidthFt,
    12,
    "one continuous wall (count=1) still computes from the unit width"
  );

  // CROSS-CHECK, DON'T AVERAGE: the disputed width is returned AS COMPUTED.
  const disputed = readStageMeasurements({
    ...base,
    spanWidthFt: 24,
    repeatingElements: { count: 5, type: "panels", estimatedWidthEachFt: 4.8 },
    sceneType: "full_venue_with_grounds",
  });
  eq(disputed.backdropWidthFt, 24, "disputed width is returned as computed, NOT averaged with the band");
  eq(disputed.widthDisputed, true, "full-venue shot vs 24ft → disputed");
  eq(disputed.sceneWidthBand.minFt, 30, "the contradicting band is recorded alongside");
  ok(
    disputed.backdropWidthFt !== (24 + 30) / 2 && disputed.backdropWidthFt !== 30,
    "never splits the difference toward the band"
  );

  // The other direction: a close-up that computes far too wide.
  const closeupTooWide = readStageMeasurements({
    ...base,
    spanWidthFt: 16,
    repeatingElements: { count: 4, type: "panels", estimatedWidthEachFt: 10 },
    sceneType: "closeup_single_element",
  });
  eq(closeupTooWide.widthDisputed, true, "close-up vs 40ft → disputed (band is under ~25ft)");
  eq(closeupTooWide.backdropWidthFt, 40, "still returns the computed width when disputed");

  // The 25-30ft gap is the "either is plausible" zone — no dispute either way.
  eq(
    readStageMeasurements({ ...base, repeatingElements: { count: 4, type: "bays", estimatedWidthEachFt: 7 }, sceneType: "stage_fills_frame" })
      .widthDisputed,
    false,
    "28ft in the gap does not dispute a fills-frame shot"
  );
  eq(
    readStageMeasurements({ ...base, repeatingElements: { count: 4, type: "bays", estimatedWidthEachFt: 7 }, sceneType: "wide_venue_shot" })
      .widthDisputed,
    false,
    "28ft in the gap does not dispute a wide shot either"
  );

  // An off-vocabulary or missing sceneType can never dispute.
  eq(
    readStageMeasurements({ ...base, repeatingElements: { count: 5, type: "panels", estimatedWidthEachFt: 5 }, sceneType: "banquet_hall" })
      .sceneType,
    null,
    "off-vocabulary sceneType → null"
  );
  eq(
    readStageMeasurements({ ...base, repeatingElements: { count: 5, type: "panels", estimatedWidthEachFt: 5 } }).widthDisputed,
    false,
    "no sceneType → nothing to dispute against"
  );

  // Garbage unit counts fall back rather than producing a 0ft backdrop.
  eq(
    readStageMeasurements({ ...base, spanWidthFt: 20, repeatingElements: { count: 0, type: "panels", estimatedWidthEachFt: 6 } })
      .backdropWidthFt,
    20,
    "count of 0 → falls back to the span"
  );

  // HEIGHT MUST NOT MOVE. It derives from span ÷ ratio and was 10/10/12 against
  // ground truth 10/10/12 — re-basing it on the counted width would break the
  // one signal that works. Same span + ratio → same height at any counted width.
  const heightAt = (each) =>
    readStageMeasurements({
      ...base,
      spanWidthFt: 24,
      widthToHeightRatio: 2.4,
      repeatingElements: { count: 5, type: "panels", estimatedWidthEachFt: each },
    }).estimatedHeightFt;
  eq(heightAt(5), 10, "span 24 ÷ 2.4 → 10ft, as before the rebuild");
  eq(heightAt(11), 10, "counted width 55ft does NOT drag the height up — still 10ft");
  eq(
    readStageMeasurements({ ...base, spanWidthFt: 24, widthToHeightRatio: 2.4 }).rawHeightEstimateFt,
    10,
    "raw height stays on the span with no unit count present"
  );

  // Floral run is capped by the COUNTED width, so a corrected-down width
  // corrects the price down with it.
  eq(
    readStageMeasurements({
      floralRunFt: 16,
      confidence: 0.6,
      spanWidthFt: 16,
      repeatingElements: { count: 1, type: "wall", estimatedWidthEachFt: 10 },
    }).floralRunFt,
    10,
    "floral run capped at the counted width (16ft haldi read → 10ft real)"
  );

  // ROUND-TRIP: the panel resends this object verbatim on a category override.
  const again = readStageMeasurements(counted);
  eq(again.backdropWidthFt, counted.backdropWidthFt, "round-trips: width stable");
  eq(again.estimatedHeightFt, counted.estimatedHeightFt, "round-trips: height stable");
  eq(again.widthBasis, counted.widthBasis, "round-trips: basis stable");
  eq(again.widthDisputed, counted.widthDisputed, "round-trips: dispute flag stable");

  // Pre-rebuild payloads (backdropWidthFt only) still read as the span.
  const legacy = readStageMeasurements({ backdropWidthFt: 24, floralRunFt: 12, widthToHeightRatio: 2.4, confidence: 0.6 });
  eq(legacy.backdropWidthFt, 24, "legacy payload: backdropWidthFt read as the span");
  eq(legacy.estimatedHeightFt, 10, "legacy payload: height unchanged");
  eq(legacy.widthBasis, "span", "legacy payload: basis is span");
}

// ── 3f. Haldi — its own pricing mode, not a discounted stage ─────────────────
{
  console.log("Haldi (own per-foot rate, tight tier spread, no artificial):");
  // Founder calibration: an 8-10ft haldi backdrop is ₹20-25k mixed and
  // ₹25-30k natural ≈ ₹3,000 per running floral foot natural (Stage: ₹6,250),
  // natural ≈ 1.2× mixed (Stage runs 1.5×).
  const nat9 = 9 * DECOR_HALDI_RATE_PER_FT;
  ok(nat9 >= 25000 && nat9 <= 30000, `9ft natural base ₹${nat9} inside the founder band 25-30k`);
  const mix9 = nat9 / HALDI_TIER_DIVISORS.mixed;
  ok(mix9 >= 20000 && mix9 <= 25000, `9ft mixed base ₹${mix9} inside the founder band 20-25k`);
  ok(DECOR_HALDI_RATE_PER_FT < DECOR_FLORAL_RATE_PER_FT, "haldi per-foot rate sits below the stage rate");

  const r = buildDemoPrice(
    analysis("Haldi", {
      stageMeasurements: { backdropWidthFt: 9, floralRunFt: 9, rawHeightEstimateFt: 7, confidence: 0.8, reasoning: "small haldi backdrop" },
    }),
    []
  );
  eq(r.rejected, false, "Haldi is a priceable demo category");
  eq(JSON.stringify(r.applicableTiers), JSON.stringify(["mixed", "natural"]), "mixed + natural only");
  eq(r.ladder[0].prices.artificial, undefined, "NO artificial tier — never offered for haldi");
  eq(r.pricingModel, "floral-run", "haldi prices by floral run");
  eq(r.sized, false, "single price block, no size ladder");
  range(r.ladder[0].prices.natural, 29000, 33000, "9ft natural = 27000 base, headroomed ±7%");
  range(r.ladder[0].prices.mixed, 24000, 27500, "9ft mixed = natural / 1.2, headroomed ±7%");

  // No measurement (e.g. a category override without vision) → the typical
  // 8-10ft backdrop midpoint prices the row instead of an empty panel.
  const fallback = buildDemoPrice(analysis("Haldi"), []);
  range(fallback.ladder[0].prices.natural, 29000, 33000, "no measurement → priced at the 9ft default run");

  // Demo-only category plumbing: Haldi resolves tiers, engine categories intact.
  eq(JSON.stringify(demoCategoryTiers("Haldi")), JSON.stringify(["mixed", "natural"]), "demoCategoryTiers admits Haldi");
  eq(JSON.stringify(demoCategoryTiers("Stage")), JSON.stringify(["artificial", "mixed", "natural"]), "engine categories unchanged");
  eq(demoCategoryTiers("Sangeet"), null, "unknown occasions still rejected");
}

// ── 3h. Occasion detection — caption + vision drive the pricing model ────────
{
  console.log("occasion detection (caption + vision):");
  // The live example that prompted this: captioned haldi, priced as a stage.
  eq(pinTextOccasionCheck("Haldi decor asthetic"), "haldi", "'Haldi decor asthetic' caption detected");
  eq(pinTextOccasionCheck("mehndi function stage"), "mehendi", "Hinglish spelling variant (mehndi) detected");
  eq(pinTextOccasionCheck("beautiful decor ideas"), null, "no occasion keyword → null");

  const vis = (value, confidence) => ({ value, confidence });
  eq(resolveOccasion("Haldi decor asthetic", vis("haldi", 0.8)).source, "both", "caption + vision agree → both");
  eq(resolveOccasion("Haldi decor asthetic", vis(null, 0)).value, "haldi", "caption alone is enough");
  eq(resolveOccasion("", vis("haldi", 0.8)).source, "vision", "confident vision alone is used");
  eq(resolveOccasion("", vis("haldi", 0.3)).value, null, "unconfident vision alone → nothing");
  const conflict = resolveOccasion("sangeet night decor", vis("haldi", 0.9));
  eq(conflict.value, "sangeet", "disagreement → the CAPTION wins");
  eq(JSON.stringify(conflict.conflict), JSON.stringify({ caption: "sangeet", vision: "haldi" }), "conflict recorded for staff details");

  // End to end: the haldi-captioned Stage pin re-prices at the haldi rate.
  const sm = { backdropWidthFt: 9, floralRunFt: 9, rawHeightEstimateFt: 7, confidence: 0.8, reasoning: "small backdrop" };
  const haldiPin = buildDemoPrice(analysis("Stage", { stageMeasurements: sm }), [], {
    occasion: resolveOccasion("Haldi decor asthetic", vis("haldi", 0.8)),
  });
  eq(haldiPin.category, "Haldi", "Stage + haldi occasion re-labels to Haldi (dropdown-correctable)");
  eq(JSON.stringify(haldiPin.applicableTiers), JSON.stringify(["mixed", "natural"]), "haldi tiers apply");
  range(haldiPin.ladder[0].prices.natural, 29000, 33000, "priced at the haldi rate, not the stage rate");
  eq(haldiPin.occasion.value, "haldi", "occasion surfaced in the response");
  eq(haldiPin.occasion.source, "both", "with its source");

  // Non-haldi occasion: surfaced, price untouched (stage rate).
  const sangeetPin = buildDemoPrice(analysis("Stage", { stageMeasurements: sm }), [], {
    occasion: resolveOccasion("sangeet night", vis(null, 0)),
  });
  eq(sangeetPin.category, "Stage", "sangeet does not change the pricing model");
  range(sangeetPin.ladder[0].prices.natural, 60000, 69000, "stage rate applies (9ft × 6250, headroomed ±7%)");
  eq(sangeetPin.occasion.value, "sangeet", "occasion still surfaced");

  // Haldi caption on a Mandap: surfaced only — the model never flips.
  const haldiMandap = buildDemoPrice(analysis("Mandap"), [], {
    occasion: resolveOccasion("haldi ceremony", vis(null, 0)),
  });
  eq(haldiMandap.category, "Mandap", "only Stage re-labels on a haldi occasion");
  eq(haldiMandap.occasion.value, "haldi", "occasion visible on the Mandap anyway");

  // Nothing confident on a Stage → stage rate by default, and SAY so.
  const unknown = buildDemoPrice(analysis("Stage", { stageMeasurements: sm }), [], {
    occasion: resolveOccasion("beautiful decor", vis(null, 0.2)),
  });
  eq(unknown.occasion.value, null, "no occasion resolved");
  eq(unknown.occasion.defaultedToStageRate, true, "explicitly flags the stage-rate default");
  range(unknown.ladder[0].prices.natural, 60000, 69000, "higher-revenue stage rate assumed");
}

// ── 3d. Vision size signals — passthrough + postProcess normalization ────────
{
  console.log("minBuildWidth / recommendedSize:");
  const { postProcess } = require("../services/decorVision");
  const p = postProcess(
    {
      isDecorProduct: true, category: "Stage", categoryConfidence: 0.9,
      size: { length: 24, width: 16, confidence: 0.6 },
      complexity: { tier: "standard", confidence: 0.7, reasoning: "x" },
      minBuildWidth: { minWidthFt: 30, reasoning: "backdrop spans five to six sofas across", confidence: 0.8 },
      recommendedSize: { length: 29, width: 17 },
      stageMeasurements: { backdropWidthFt: 24, floralRunFt: 30, rawHeightEstimateFt: 13, reasoning: "r", confidence: 0.7 },
    },
    "demo"
  );
  eq(p.minBuildWidth.minWidthFt, 30, "minWidthFt normalized");
  eq(p.minBuildWidth.confidence, 0.8, "min-width confidence kept");
  eq(p.recommendedSize, "30x16", "recommendedSize snapped to the Stage vocabulary (29x17 → 30x16)");
  eq(p.stageMeasurements.floralRunFt, 24, "postProcess caps floral run at backdrop width");
  eq(p.stageMeasurements.estimatedHeightFt, 12, "postProcess snaps 13ft raw to the 12ft build height");
  eq(p.stageMeasurements.rawHeightEstimateFt, 13, "raw height preserved for staff details");
  const empty = postProcess({ isDecorProduct: true, category: "Stage", size: {}, complexity: {} }, "demo");
  eq(empty.minBuildWidth, null, "absent minBuildWidth → null, never fabricated");
  eq(empty.recommendedSize, null, "absent recommendedSize → null, never snapped from nothing");

  const comps = [doc("st_ref", "R", { "Natural Flowers": 90000 }, [24, 16])];
  const out = buildDemoPrice(
    analysis("Stage", { minBuildWidth: p.minBuildWidth, recommendedSize: p.recommendedSize }),
    comps
  );
  eq(out.minBuildWidth.minWidthFt, 30, "minBuildWidth passes through the demo response");
  eq(out.recommendedSize, "30x16", "recommendedSize passes through the demo response");
  const bare = buildDemoPrice(analysis("Stage"), comps);
  eq(bare.minBuildWidth, null, "no vision signal → null in the response");
  eq(bare.recommendedSize, null, "no vision signal → null in the response");
}

// ── 4. Non-décor image → rejected ────────────────────────────────────────────
{
  console.log("Non-décor rejection:");
  const r = buildDemoPrice(
    { isDecorProduct: false, category: null, complexity: { reasoning: "This is a wedding cake." } },
    []
  );
  eq(r.rejected, true, "rejected:true");
  eq(r.reason, "This is a wedding cake.", "reason surfaced from vision reasoning");
  ok(!r.ladder, "no ladder on rejection");
}

// ── 5. Phoolon Ki Chadar — mixed+natural, no artificial, no size ladder ──────
{
  console.log("Phoolon Ki Chadar (mixed+natural):");
  const comps = [
    doc("pk1", "A", { Mixed: 17000, Natural: 20000 }),
    doc("pk2", "B", { Mixed: 17000, Natural: 20000 }),
  ];
  const r = buildDemoPrice(analysis("Phoolon Ki Chadar"), comps);
  eq(r.sized, false, "no size ladder");
  eq(JSON.stringify(r.applicableTiers), JSON.stringify(["mixed", "natural"]), "mixed + natural only");
  eq(r.ladder[0].prices.artificial, undefined, "never shows an artificial tier");
  range(r.ladder[0].prices.mixed, 19500, 24500, "mixed anchored on its own p75 × 1.15");
  range(r.ladder[0].prices.natural, 23000, 29000, "natural anchored on its own p75 × 1.15");
}

// ── 5b. Observations pass through untouched — never graded, never priced ─────
{
  console.log("observations passthrough:");
  const comps = [doc("na1", "A", { Natural: 8000 })];
  const obs = ["temple-style structure", "full floral coverage", "chandeliers"];
  const withObs = buildDemoPrice(analysis("Mala & More", { observations: obs }), comps);
  eq(JSON.stringify(withObs.observations), JSON.stringify(obs), "observations echoed verbatim");
  const withoutObs = buildDemoPrice(analysis("Mala & More"), comps);
  eq(JSON.stringify(withoutObs.observations), JSON.stringify([]), "missing observations → empty array");
  range(withObs.ladder[0].prices.natural, 9000, 11500, "prices identical with observations present");
}

// ── 6. pin-text cross-check (quiet staff signal) ─────────────────────────────
{
  console.log("pin-text cross-check:");
  eq(pinTextCategoryCheck("Royal shaadi mandap decor", "Mandap").agrees, true, "caption 'mandap' agrees with Mandap");
  eq(pinTextCategoryCheck("varmala stage backdrop", "Stage").detectedCategory, "Stage", "first keyword hit wins (stage)");
  eq(pinTextCategoryCheck("beautiful decor", "Stage").agrees, null, "uninformative caption → agrees null");
  eq(pinTextCategoryCheck("", "Stage"), null, "empty pinText → null");
  eq(pinTextCategoryCheck("mandap flowers", "Stage").agrees, false, "conflict flagged (mandap vs Stage)");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
