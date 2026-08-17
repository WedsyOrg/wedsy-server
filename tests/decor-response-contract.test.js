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
const { buildDemoPrice, buildStorePrice, resolveOccasion } = require("../services/decorDemoPrice");
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
  // ⚠️ CHANGED 2026-08-17. This fixture's "haldi ceremony" caption re-labels the
  // Stage to Haldi (asserted below), and haldi is now EXEMPT from the structure
  // charge at any width — so there is no ratePerSqFt to assert here. Note the old
  // behaviour this exposes: a 36ft haldi used to be charged the ₹390/sqft
  // FABRICATION rate (~₹1.6L) because the pre-2026-08-17 code keyed on width
  // alone and never on category. The exemption fixes that latent bug.
  ok(raw.floralRatePerFt > 0 && raw.headroomApplied > 1,
    "SERVICE stays fully expressive (rate + headroom present internally)");
  eq(raw.structure.band, "exempt", "haldi is exempt from the structure charge at 36ft");
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
  // CHANGED 2026-08-17: exempt (haldi) → no fabrication → structureHeavy false.
  // The structureHeavy:true path is covered by the genuine-Stage block below.
  eq(out.structureHeavy, false, "structureHeavy:false — haldi is exempt, nothing fabricated");
  // ADDED 2026-08-17 — the presentation switch. Haldi is ALWAYS floral-run
  // priced (it falls back to a 9ft default run when unmeasured), so this is true
  // here even though nothing is fabricated. Revives the five panel features that
  // had been gated on the stripped `pricingModel`.
  eq(out.floralRunPriced, true, "floralRunPriced:true on Haldi (always floral-run priced)");
  ok(typeof out.floralRunPriced === "boolean", "…and it is a plain boolean, carrying no rate or method");
  ok(!("pricingModel" in out) && !("floralRatePerFt" in out),
    "…while pricingModel and the rate stay stripped — presentation without method");
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

  // ── ADDED 2026-08-17 — genuine Stage at 36ft, so structureHeavy:true is still
  // covered after the haldi fixture above became exempt. Also pins the new
  // two-band split at the wire: `fabricated` drives the flag, `applies` does not.
  const fabricated = buildDemoPrice(
    {
      isDecorProduct: true, category: "Stage", categoryConfidence: 0.9,
      observations: [], stageMeasurements: MEASURED,
    },
    [doc("st9", "Wide Build", { natural: 90000, mixed: 60000 }, [16, 12])],
    {}
  );
  const fabOut = shapeClientResponse("demo-price", fabricated);
  assertClean(fabOut, "demo-price");
  eq(fabricated.structure.band, "fabricated", "36ft Stage is in the fabricated band");
  eq(fabricated.structure.fabricated, true, "…and flagged fabricated");
  eq(fabOut.structureHeavy, true, "structureHeavy:true replaces the threshold/rate/split");
  ok(!("structure" in fabOut), "the structure OBJECT never reaches the wire — only the boolean");
  eq(fabricated.floralRunPriced, true, "36ft measured Stage was priced by floral run (service)");
  eq(fabOut.floralRunPriced, true, "…and floralRunPriced:true reaches the wire");
  ok(!("pricingModel" in fabOut) && !("floralRatePerFt" in fabOut), "…with no rate or method alongside it");

  // A sub-30ft Stage: a charge applies, but it is NOT fabricated, so the
  // negotiating-margin flag must stay false. This is the distinction the
  // 2026-08-17 light band introduced.
  const light = buildDemoPrice(
    {
      isDecorProduct: true, category: "Stage", categoryConfidence: 0.9, observations: [],
      stageMeasurements: { backdropWidthFt: 24, floralRunFt: 18, rawHeightEstimateFt: 12, confidence: 0.8, reasoning: "mid build" },
    },
    [], {}
  );
  const lightOut = shapeClientResponse("demo-price", light);
  eq(light.structure.applies, true, "24ft Stage: a light charge DOES apply");
  eq(light.structure.fabricated, false, "…but nothing is fabricated");
  eq(lightOut.structureHeavy, false, "…so structureHeavy stays false — the flag keeps its meaning");
  eq(lightOut.floralRunPriced, true, "a measured sub-30ft Stage is still floral-run priced");

  // ── ADDED 2026-08-17 — the SIZE-BUCKET case: no measurement, so the build was
  // priced from the smoothed area ladder, not floral run.
  const bucketed = buildDemoPrice(
    { isDecorProduct: true, category: "Stage", categoryConfidence: 0.9, observations: [] },
    [doc("st7", "A", { natural: 90000 }, [24, 16]), doc("st8", "B", { natural: 88000 }, [24, 16])],
    {}
  );
  const bucketOut = shapeClientResponse("demo-price", bucketed);
  assertClean(bucketOut, "demo-price");
  eq(bucketed.floralRunPriced, false, "no measurement → size-bucket priced, not floral run");
  eq(bucketOut.floralRunPriced, false, "…and floralRunPriced:false reaches the wire");
  ok(bucketOut.ladder.length > 1, "…confirmed by a multi-row size ladder rather than one block");

  // ── THE DIVERGENCE THIS FLAG EXISTS FOR ───────────────────────────────────
  // A non-floral-run CATEGORY carrying a backdrop measurement. The wire emits
  // `stageMeasurements` anyway (deliberate — the panel resends it with a
  // category override), but pricing came from the size ladder. So the client
  // cannot infer floral-run pricing from the measurement's presence, which is
  // exactly why one explicit boolean was added instead of re-exposing
  // pricingModel.
  const mandap = buildDemoPrice(
    { isDecorProduct: true, category: "Mandap", categoryConfidence: 0.9, observations: [], stageMeasurements: MEASURED },
    [doc("ma1", "M", { natural: 150000 }, [12, 12])],
    {}
  );
  const mandapOut = shapeClientResponse("demo-price", mandap);
  assertClean(mandapOut, "demo-price");
  ok(mandapOut.stageMeasurements && mandapOut.stageMeasurements.backdropWidthFt === 36,
    "Mandap DOES carry measurements on the wire (ungated, deliberate)");
  eq(mandap.floralRunPriced, false, "…but it was NOT floral-run priced");
  eq(mandapOut.floralRunPriced, false,
    "…so floralRunPriced:false — measurements present, floral-run pricing absent");
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

// ── 6. Read provenance + the from-store reply (ADDED 2026-08-17) ─────────────
// The pin-level read cache put two new things on this wire: a `read` provenance
// object, and buildStorePrice's reply for a pin that is already a product. Both
// have to clear the same allowlist as everything else.
{
  console.log("\nRead provenance + from-store reply:");

  const withRead = shapeDemoPrice({
    rejected: false, category: "Stage", categoryConfidence: 0.9, observations: [],
    applicableTiers: ["natural"], ladder: [{ size: "16x12", prices: { natural: { low: 1000, high: 1250 } } }],
    read: {
      origin: "cached",
      firstReadAt: "2026-08-14T00:00:00.000Z",
      // Fields the cache carries internally that must NOT reach the panel.
      hits: 7, reads: 2, analysis: { complexity: { reasoning: "leak" } }, sourceUrl: "https://i.pinimg.com/564x/a/b/c.jpg",
    },
  });
  assertClean(withRead, "demo-price with provenance");
  eq(withRead.read.origin, "cached", "read.origin kept");
  eq(withRead.read.firstReadAt, "2026-08-14T00:00:00.000Z", "read.firstReadAt kept");
  eq(JSON.stringify(Object.keys(withRead.read).sort()), JSON.stringify(["firstReadAt", "origin"]),
    "…and NOTHING else — no hit counters, no stored analysis, no raw source URL");
  // The key is `origin`, not `source`: `source` is on the FORBIDDEN list (it is
  // how occasion narrates which signal decided it), and provenance must not
  // force a hole in that check.
  ok(!("source" in withRead.read), "provenance is `origin` — `source` stays a forbidden key name");

  // A cached REJECTION is still a read, and still says so.
  const rej = shapeDemoPrice({ rejected: true, reason: "Not a décor product.", read: { origin: "cached" } });
  assertClean(rej, "cached rejection");
  eq(rej.read.origin, "cached", "a replayed rejection reports its provenance too");

  // from-store: the live product price, through the same shaper.
  const store = buildStorePrice(
    {
      category: "Stage",
      name: "Ivory Grace",
      productTypes: [
        { name: "Artificial Flowers", sellingPrice: 55000 },
        { name: "Natural Flowers", sellingPrice: 79000 },
      ],
      productInfo: { id: "st164", measurements: { length: 16, width: 12 } },
    },
    { analysis: { observations: ["mirror panels"], stageMeasurements: MEASURED } }
  );
  const shaped = shapeDemoPrice({ ...store, read: { origin: "from-store", product: { code: "st164", name: "Ivory Grace" } } });
  assertClean(shaped, "from-store reply");
  eq(shaped.ladder[0].prices.artificial.low, 55000, "the live selling price is the ladder");
  eq(shaped.ladder[0].prices.artificial.high, 55000, "…as a point, not a range");
  eq(shaped.ladder[0].size, "16x12", "…at the product's own size");
  eq(shaped.floralRunPriced, false, "floralRunPriced:false — nothing was estimated");
  eq(shaped.structureHeavy, false, "structureHeavy:false — no fabrication was computed");
  eq(shaped.read.product.code, "st164", "the product code identifies it (read.product.code)");
  ok(!("headroomApplied" in shaped) && !("sized" in shaped) && !("upliftApplied" in shaped),
    "…while the store reply's own method keys are stripped like any other");
  // The descriptive half of a cached read still comes through.
  eq(JSON.stringify(shaped.observations), JSON.stringify(["mirror panels"]), "cached observations survive");
  eq(shaped.stageMeasurements.backdropWidthFt, 36, "…as does the cached measurement line");
}

console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
