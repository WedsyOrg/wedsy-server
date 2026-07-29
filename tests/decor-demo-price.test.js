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
  eq(r.ladder[0].prices.flat, 20000, "flat = median of comparables");
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
  eq(r.ladder[0].prices.natural, 8000, "natural = median of comparables");
  eq(r.ladder[0].prices.artificial, undefined, "no artificial tier");
  eq(r.ladder[0].prices.mixed, undefined, "no mixed tier");
}

// ── 3. Stage — full ladder ───────────────────────────────────────────────────
{
  console.log("Stage (full size ladder):");
  // Sized-row prices come from the engine's size lookup, so comps aren't needed
  // for the price assertions; add a couple with sizes for the examples test.
  const comps = [
    doc("st_a", "SA", { "Natural Flowers": 60000 }, [16, 12]), // 192 bucket
    doc("st_b", "SB", { "Natural Flowers": 90000 }, [24, 16]), // 384 bucket
  ];
  const r = buildDemoPrice(analysis("Stage"), comps, { includeExamples: true });
  eq(r.sized, true, "Stage is size-laddered");
  eq(r.ladder.length, SIZE_BUCKETS.Stage.length, "one row per Stage bucket (8)");
  eq(JSON.stringify(r.applicableTiers), JSON.stringify(["artificial", "mixed", "natural"]), "all three tiers");

  const row1612 = r.ladder.find((x) => x.size === "16x12");
  eq(row1612.prices.natural, 46000, "16x12 natural = size-lookup median");
  eq(row1612.prices.artificial, 31944, "16x12 artificial = natural / 1.44");
  eq(row1612.prices.mixed, 38972, "16x12 mixed = artificial × 1.22");
  const row2416 = r.ladder.find((x) => x.size === "24x16");
  eq(row2416.prices.natural, 80000, "24x16 natural = size-lookup median");

  // examplesAtThisSize: scale/price-point proof, bucketed by nearest size.
  ok(Array.isArray(row1612.examplesAtThisSize), "16x12 row has examplesAtThisSize array");
  eq(row1612.examplesAtThisSize[0] && row1612.examplesAtThisSize[0].productCode, "st_a", "16x12 example is the 192-bucket product");
  ok(row1612.examplesAtThisSize[0].image === "https://cdn/st_a.jpg", "example carries an image URL");
  eq(row2416.examplesAtThisSize[0] && row2416.examplesAtThisSize[0].productCode, "st_b", "24x16 example is the 384-bucket product");
  // no similarity naming anywhere
  ok(!("similar" in row1612) && !("matches" in row1612), "field is examplesAtThisSize, not similar/matches");
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
  eq(r.ladder[0].prices.mixed, 17000, "mixed median");
  eq(r.ladder[0].prices.natural, 20000, "natural median");
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
