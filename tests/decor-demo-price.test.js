// Demo-price ladder tests. Run: node tests/decor-demo-price.test.js
// PURE (no DB, no vision): drives buildDemoPrice with a synthetic Phase B
// analysis + comparables. Covers a flat-price category, a natural-only category,
// a Stage full ladder, and a non-décor rejection — plus category-aware tiers,
// no-uplift, examplesAtThisSize, and the pin-text cross-check.
const { buildDemoPrice, pinTextCategoryCheck, SIZE_BUCKETS } = require("../services/decorDemoPrice");
const { normalizeComparable } = require("../services/decorPricing");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${got} vs ${want})`);
// Tier prices are RANGES ({low, high}); a lookup fallback collapses to low==high.
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
  range(r.ladder[0].prices.flat, 18750, 21250, "flat = p25–p75 of comparables");
  eq(r.ladder[0].prices.natural, undefined, "no natural tier on a flat category");
  eq(r.upliftApplied, 1, "no uplift");
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
  range(r.ladder[0].prices.natural, 8000, 9000, "natural = p25–p75 of comparables");
  eq(r.ladder[0].prices.artificial, undefined, "no artificial tier");
  eq(r.ladder[0].prices.mixed, undefined, "no mixed tier");
}

// ── 3. Stage — full ladder priced from LIVE orderable comparables ────────────
{
  console.log("Stage (full size ladder, live comparables):");
  const comps = [
    doc("st_a", "SA", { "Natural Flowers": 40000 }, [16, 12]), // 192 bucket
    doc("st_b", "SB", { "Natural Flowers": 50000 }, [16, 12]), // 192 → median 45000
    doc("st108", "OUT", { "Natural Flowers": 300000 }, [16, 12]), // 192 premium OUTLIER
    doc("st_c", "SC", { "Natural Flowers": 90000 }, [24, 16]), // 384 bucket
    // nothing at 40x20 → that row must fall back to the engine size lookup
  ];
  const r = buildDemoPrice(analysis("Stage"), comps, { includeExamples: true });
  eq(r.sized, true, "Stage is size-laddered");
  eq(r.ladder.length, SIZE_BUCKETS.Stage.length, "one row per Stage bucket (8)");
  eq(JSON.stringify(r.applicableTiers), JSON.stringify(["artificial", "mixed", "natural"]), "all three tiers");

  const row1612 = r.ladder.find((x) => x.size === "16x12");
  eq(row1612.priceBasis, "live", "16x12 priced from live comparables");
  range(row1612.prices.natural, 42500, 47500, "16x12 natural = p25–p75 (outlier excluded)");
  eq(row1612.comparablesUsed, 2, "premium outlier st108 excluded from the range");
  range(row1612.prices.artificial, 29514, 32986, "16x12 artificial = natural / 1.44 (ladder)");
  range(row1612.prices.mixed, 36007, 40243, "16x12 mixed = artificial × 1.22 (ladder)");
  // premiumCeiling is a SEPARATE claim — highest orderable incl. the outlier.
  eq(row1612.premiumCeiling, 300000, "16x12 ceiling = max incl. premium outlier st108");
  ok(row1612.premiumCeiling !== row1612.prices.natural.high, "ceiling and typical range are distinct, not merged");

  const row2416 = r.ladder.find((x) => x.size === "24x16");
  range(row2416.prices.natural, 90000, 90000, "24x16 natural = single comp → collapsed range");
  eq(row2416.premiumCeiling, 90000, "24x16 ceiling = the single product (no outlier here)");

  const row4020 = r.ladder.find((x) => x.size === "40x20");
  eq(row4020.priceBasis, "lookup", "40x20 has no live comps → falls back to the table");
  range(row4020.prices.natural, 257500, 257500, "40x20 natural = engine size lookup (collapsed range)");
  eq(row4020.premiumCeiling, null, "40x20 has no comparables → no ceiling");

  // examplesAtThisSize: scale/price-point proof, bucketed by nearest size.
  ok(Array.isArray(row1612.examplesAtThisSize), "16x12 row has examplesAtThisSize array");
  ok(row1612.examplesAtThisSize[0].image === "https://cdn/st_a.jpg", "example carries an image URL");
  eq(row2416.examplesAtThisSize[0] && row2416.examplesAtThisSize[0].productCode, "st_c", "24x16 example is the 384-bucket product");
  ok(!("similar" in row1612) && !("matches" in row1612), "field is examplesAtThisSize, not similar/matches");
}

// ── 3b. Mandap 15x15 — live fixes the missing-lookup-bucket underpricing ─────
{
  console.log("Mandap 15x15 (live fixes the 256-snap bug):");
  // SIZE_LOOKUP.Mandap has no 225 (15x15) entry, so the engine snaps it to the
  // 256 bucket (₹82,000). Live comparables at 15x15 price it correctly.
  const comps = [
    doc("ma_x", "MX", { "Natural Flowers": 150000 }, [15, 15]),
    doc("ma_y", "MY", { "Natural Flowers": 150000 }, [15, 15]),
  ];
  const r = buildDemoPrice(analysis("Mandap"), comps);
  const row = r.ladder.find((x) => x.size === "15x15");
  eq(row.priceBasis, "live", "15x15 priced from live comparables");
  range(row.prices.natural, 150000, 150000, "15x15 natural = live comps (not the 82000 snap-to-256)");
  range(row.prices.artificial, 96154, 96154, "15x15 artificial = natural / 1.56 (Mandap ladder)");
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
  range(r.ladder[0].prices.mixed, 17000, 17000, "mixed p25–p75");
  range(r.ladder[0].prices.natural, 20000, 20000, "natural p25–p75");
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
  range(withObs.ladder[0].prices.natural, 8000, 8000, "prices identical with observations present");
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
