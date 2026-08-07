// DÉCOR AI RESPONSE CONTRACT — what /decor/demo-price and /decor/analyse-image
// are allowed to put on the wire. Run: node tests/decor-response-contract.test.js
//
// PURE (no DB, no vision call, no HTTP): drives the REAL services to produce
// genuine engine output, then runs it through the controller's
// shapeClientResponse() boundary and asserts three things —
//   1. every method-revealing key is ABSENT at any depth (rate constants, tier
//      ladders, multipliers, thresholds, derivation prose, confidence gates,
//      the comparables table);
//   2. the operational TRANSFORMS are present and correct (confirmWidth,
//      structureHeavy, lowConfidence);
//   3. the KEPT outputs survive with their values intact.
// It also asserts the SERVICES stay fully expressive — the raw objects still
// carry everything — proving the trim happens at the boundary, not in the
// engine, so internal callers keep reading the whole thing.
const {
  shapeClientResponse,
  shapeDemoPrice,
  shapeAnalyseImage,
} = require("../controllers/decor");
const { buildDemoPrice, resolveOccasion } = require("../services/decorDemoPrice");
const { suggestPrice, normalizeComparable } = require("../services/decorPricing");
const { postProcess } = require("../services/decorVision");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${JSON.stringify(got)} vs ${JSON.stringify(want)})`);

// Walk a payload and collect every key name at every depth.
const keysDeep = (v, acc = new Set()) => {
  if (Array.isArray(v)) { v.forEach((x) => keysDeep(x, acc)); return acc; }
  if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v)) { acc.add(k); keysDeep(val, acc); }
  }
  return acc;
};
// Every key that would narrate HOW a price was produced.
const FORBIDDEN = [
  // rate constants + the structure charge's internals
  "floralRatePerFt", "ratePerSqFt", "thresholdFt", "areaSqFt", "cost", "geometry",
  "structure", "widthFt", "heightFt",
  // multipliers / ladders / model labels
  "headroomApplied", "upliftApplied", "pricingModel", "sized", "factor", "bandPosition",
  // derivation + competing bases
  "reasoning", "widthBasis", "spanWidthFt", "sceneType", "sceneWidthBand", "widthDisputed",
  "structureGeometry", "floralCoverageFraction", "rawHeightEstimateFt", "widthToHeightRatio",
  // gates, anchors, percentile machinery, the comparables table
  "confidence", "anchor", "priceBasis", "comparablesUsed", "observedBand", "sizeBasis",
  "comparables", "complexity", "fallbacks", "area", "productCode", "source",
  "defaultedToStageRate",
];
const assertClean = (payload, label) => {
  const keys = keysDeep(payload);
  const leaked = FORBIDDEN.filter((k) => keys.has(k));
  ok(leaked.length === 0, `${label}: no method keys on the wire${leaked.length ? ` — LEAKED: ${leaked.join(", ")}` : ""}`);
};

const doc = (id, name, tiers, size) => normalizeComparable({
  name,
  image: `https://cdn/${id}.jpg`,
  productInfo: { id, measurements: size ? { length: size[0], width: size[1] } : {} },
  productTypes: Object.entries(tiers).map(([n, sellingPrice]) => ({ name: n, sellingPrice })),
});
// A measured 36ft backdrop: wide enough that the fabrication charge applies.
const MEASURED = {
  spanWidthFt: 36, floralRunFt: 30, confidence: 0.6,
  repeatingElements: { count: 6, estimatedWidthEachFt: 6 },
  widthToHeightRatio: 3, structureGeometry: "flat", sceneType: "indoor-hall",
  reasoning: "six panels across the span",
};
const MIN_BUILD = { minWidthFt: 30, reasoning: "backdrop fits six sofas across", confidence: 0.7 };

// ── 1. Measured Stage — the richest payload ──────────────────────────────────
{
  console.log("Measured Stage (structure applies):");
  const raw = buildDemoPrice(
    {
      isDecorProduct: true, category: "Stage", categoryConfidence: 0.9,
      observations: ["marigold garlands", "mirror panels"],
      minBuildWidth: MIN_BUILD, recommendedSize: "16x12", stageMeasurements: MEASURED,
    },
    [doc("st1", "Ivory Grace", { natural: 90000, mixed: 60000 }, [16, 12])],
    { includeExamples: true, occasion: resolveOccasion("haldi ceremony", null) }
  );
  const out = shapeClientResponse("demo-price", raw);

  // the engine still knows everything — the trim is at the boundary
  ok(raw.floralRatePerFt > 0 && raw.headroomApplied > 1 && raw.structure.ratePerSqFt > 0,
    "SERVICE stays fully expressive (rate, headroom, structure rate all present internally)");
  ok(raw.stageMeasurements.reasoning && raw.stageMeasurements.widthBasis,
    "…including the derivation prose and the width basis");

  assertClean(out, "demo-price");
  eq(out.rejected, false, "rejected:false kept");
  eq(out.category, "Haldi", "category kept (haldi occasion re-labels the Stage)");
  eq(out.categoryConfidence, 0.9, "categoryConfidence kept");
  eq(JSON.stringify(out.observations), JSON.stringify(["marigold garlands", "mirror panels"]), "observations kept");
  eq(out.recommendedSize, "16x12", "recommendedSize kept");
  eq(JSON.stringify(out.minBuildWidth), JSON.stringify({ minWidthFt: 30 }), "minBuildWidth keeps the VALUE, drops prose + confidence");

  // measurements: numbers + the correction affordance, nothing else
  eq(JSON.stringify(out.stageMeasurements), JSON.stringify({
    backdropWidthFt: 36, estimatedHeightFt: 12, floralRunFt: 30,
    repeatingElements: { count: 6, estimatedWidthEachFt: 6 },
  }), "measurements keep the numbers + repeatingElements only");
  ok(raw.stageMeasurements.repeatingElements.type === "units" && !out.stageMeasurements.repeatingElements.type,
    "…repeatingElements trimmed to {count, estimatedWidthEachFt}");

  // transforms
  eq(out.structureHeavy, true, "structureHeavy:true replaces the threshold/rate/split");
  eq(out.confirmWidth, true, "confirmWidth:true (36ft > 25ft)");
  eq(out.lowConfidence, false, "lowConfidence:false passthrough");

  // occasion: the value and an operational conflict, never the source ranking
  eq(out.occasion.value, "haldi", "occasion.value kept");
  ok(!("source" in out.occasion), "occasion.source stripped");

  // the ladder — the actual deliverable
  ok(out.ladder.length === 1 && out.ladder[0].prices.natural.low > 0, "price ladder kept (tier → {low, high})");
  eq(out.ladder[0].prices.natural.low, raw.ladder[0].prices.natural.low, "…with the engine's exact figures");
  ok(!("area" in out.ladder[0]), "ladder row drops `area`");
  const ex = out.ladder[0].examplesAtThisSize[0];
  eq(JSON.stringify(Object.keys(ex).sort()), JSON.stringify(["image", "name", "size"]), "examples carry name + image + size only");
  ok(raw.ladder[0].examplesAtThisSize[0].price > 0 && !("price" in ex), "…never the example's price");
  ok(!("productCode" in ex), "…never the product code");
}

// ── 2. Transform edges ───────────────────────────────────────────────────────
{
  console.log("\nTransform edges:");
  const build = (sm) => shapeDemoPrice(buildDemoPrice(
    { isDecorProduct: true, category: "Stage", categoryConfidence: 0.8, observations: [], stageMeasurements: sm },
    [], {}
  ));
  // narrow + confident → nothing to verify, no fabrication charge
  const narrow = build({ spanWidthFt: 20, floralRunFt: 16, confidence: 0.8, widthToHeightRatio: 2 });
  eq(narrow.confirmWidth, false, "confirmWidth:false at 20ft with good confidence");
  eq(narrow.structureHeavy, false, "structureHeavy:false below the (unstated) threshold");
  eq(narrow.lowConfidence, false, "lowConfidence:false");
  // narrow but unsure → confidence is stripped, so the boolean carries the job
  const unsure = build({ spanWidthFt: 20, floralRunFt: 16, confidence: 0.05, widthToHeightRatio: 2 });
  eq(unsure.lowConfidence, true, "lowConfidence:true when the measurement is shaky");
  eq(unsure.confirmWidth, true, "…and confirmWidth:true even at 20ft (low confidence forces a check)");
  assertClean(unsure, "shaky measurement");
  // just over the confirm line
  eq(build({ spanWidthFt: 26, floralRunFt: 20, confidence: 0.8, widthToHeightRatio: 2 }).confirmWidth, true, "confirmWidth:true at 26ft");
}

// ── 3. Sized ladder (no measurement) + rejection ─────────────────────────────
{
  console.log("\nSized ladder + rejection:");
  const comps = [
    doc("md1", "A", { natural: 120000, mixed: 80000 }, [16, 12]),
    doc("md2", "B", { natural: 150000, mixed: 95000 }, [20, 16]),
  ];
  const raw = buildDemoPrice({ isDecorProduct: true, category: "Mandap", categoryConfidence: 0.95, observations: [] }, comps, { includeExamples: true });
  const out = shapeDemoPrice(raw);
  assertClean(out, "sized Mandap ladder");
  ok(out.ladder.length > 1, `size ladder kept (${out.ladder.length} rows)`);
  ok(out.ladder.every((r) => r.size && r.prices), "every row keeps size + prices");
  ok(raw.anchor && raw.anchor.priceBasis, "SERVICE still exposes the reference anchor internally");
  eq(out.structureHeavy, false, "no measurement → structureHeavy:false");
  eq(out.confirmWidth, false, "no measurement → confirmWidth:false");

  const rej = shapeDemoPrice(buildDemoPrice({ isDecorProduct: false, complexity: { reasoning: "a plate of food, scaled from the fork" } }, []));
  assertClean(rej, "rejection");
  eq(rej.rejected, true, "rejection kept");
  ok(typeof rej.reason === "string" && rej.reason.length > 0, "client-safe reason kept");
}

// ── 4. analyse-image ─────────────────────────────────────────────────────────
{
  console.log("\nanalyse-image:");
  const analysis = postProcess({
    isDecorProduct: true, category: "Stage", categoryConfidence: 0.88, style: "Modern",
    size: { length: 16, width: 12, confidence: 0.42 },
    complexity: { tier: "elaborate", confidence: 0.8, reasoning: "dense floral across the full span" },
    observations: ["marigold garlands"], minBuildWidth: MIN_BUILD, recommendedSize: { length: 16, width: 12 },
    stageMeasurements: MEASURED, occasion: { value: "sangeet", confidence: 0.7 },
  }, "demo");
  const pricing = suggestPrice(
    { category: "Stage", length: 16, width: 12, complexity: "elaborate", source: "extension" },
    [doc("st1", "A", { natural: 90000, mixed: 60000 }, [16, 12]), doc("st2", "B", { natural: 110000, mixed: 70000 }, [20, 16])]
  );
  const out = shapeClientResponse("analyse-image", { analysis, pricing, fallbacks: ["size: low confidence (0.42) — ignored, using the category band (median)"] });

  ok(analysis.complexity.reasoning && pricing.comparables.length > 0,
    "SERVICES stay fully expressive (complexity prose + comparables table present internally)");
  assertClean(out, "analyse-image");

  eq(out.analysis.category, "Stage", "analysis.category kept");
  eq(out.analysis.style, "Modern", "analysis.style kept");
  eq(JSON.stringify(out.analysis.size), JSON.stringify({ length: 16, width: 12 }), "size VALUES kept, its confidence gate stripped");
  ok(!("complexity" in out.analysis), "analysis.complexity stripped entirely (it is the ladder's band input)");
  eq(out.analysis.occasion.value, "sangeet", "occasion.value kept");
  // `suggested` is a per-tier object — compare by value, not by reference
  eq(JSON.stringify(out.pricing.suggested), JSON.stringify(pricing.suggested), "pricing.suggested kept unchanged");
  ok(!("comparables" in out.pricing), "pricing.comparables[] STRIPPED (the reconstructable price table)");
  ok(!("observedBand" in out.pricing), "pricing.observedBand stripped");
  eq(out.lowConfidence, true, "fallbacks[] collapse to lowConfidence:true");
  eq(out.confirmWidth, true, "confirmWidth derived from the measurement");

  const rejected = shapeAnalyseImage({ analysis: postProcess({ isDecorProduct: false }, "demo"), pricing: null, rejected: true });
  assertClean(rejected, "analyse-image rejection");
  eq(rejected.rejected, true, "rejection flag kept");
  eq(rejected.pricing, null, "no pricing on a rejection");
}

// ── 5. Defensive deep-strip ──────────────────────────────────────────────────
{
  console.log("\nDefensive deep-strip:");
  const out = shapeDemoPrice({
    rejected: false, category: "Stage", categoryConfidence: 0.9, observations: [],
    applicableTiers: ["natural"],
    // a future service field nesting prose inside something we forward wholesale
    ladder: [{ size: "16x12", prices: { natural: { low: 1000, high: 1250, reasoning: "p75 × headroom" } } }],
    pinTextCheck: { detectedCategory: "Mandap", agrees: false, reasoning: "caption says mandap" },
  });
  assertClean(out, "nested prose");
  ok(!("reasoning" in out.ladder[0].prices.natural), "nested reasoning stripped inside a forwarded price object");
  ok(!("reasoning" in out.pinTextCheck), "…and inside pinTextCheck");
  eq(out.pinTextCheck.agrees, false, "pinTextCheck's operational fields survive");
  eq(out.ladder[0].prices.natural.low, 1000, "…and the prices themselves are untouched");
}

console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
