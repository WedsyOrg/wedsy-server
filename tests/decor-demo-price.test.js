// Demo-price ladder tests. Run: node tests/decor-demo-price.test.js
// PURE (no DB, no vision): drives buildDemoPrice with a synthetic Phase B
// analysis + comparables. Covers a flat-price category, a natural-only category,
// a Stage full ladder, and a non-décor rejection — plus category-aware tiers,
// the negotiating anchor (p75 × headroom, low = high × 0.8), the founder's
// Mandap ladder, examplesAtThisSize, and the pin-text cross-check.
const { buildDemoPrice, pinTextCategoryCheck, SIZE_BUCKETS } = require("../services/decorDemoPrice");
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
    },
    "demo"
  );
  eq(p.minBuildWidth.minWidthFt, 30, "minWidthFt normalized");
  eq(p.minBuildWidth.confidence, 0.8, "min-width confidence kept");
  eq(p.recommendedSize, "30x16", "recommendedSize snapped to the Stage vocabulary (29x17 → 30x16)");
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
