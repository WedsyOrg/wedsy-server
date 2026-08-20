/**
 * SOURCE STAMP + ANALYSIS LOOKUP (2026-08-20).
 *
 *   1. Decor.source = "extension" on A2S approve; unset for manual products;
 *      filterable via GET /decor?source=extension.
 *   2. GET /decor/:_id/analysis — a REVERSE lookup into the draft that published
 *      the product. Never a copy: draft.aiAnalysis stays the single source of
 *      truth. 404 + code NO_DRAFT is the normal answer for a manual product.
 *
 * AI edges stubbed via DecorDraftService.__deps — no Anthropic, no S3.
 *
 *   node tests/decor-source-and-analysis.test.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

const DecorDraft = require("../models/DecorDraft");
const Decor = require("../models/Decor");
const DecorDraftService = require("../services/DecorDraftService");
const decor = require("../controllers/decor");
const { readStageMeasurements } = require("../services/decorDemoPrice");

const TAG = `src-${Date.now()}`;
const CAT = "Stage";
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${JSON.stringify(got)} vs ${JSON.stringify(want)})`);

const call = (handler, { params = {}, query = {}, body = {} } = {}) =>
  new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      send(b) { resolve({ status: this.statusCode, body: b }); },
      json(b) { resolve({ status: this.statusCode, body: b }); },
    };
    Promise.resolve(handler({ params, query, body }, res)).catch((e) => resolve({ status: 500, body: { message: e.message } }));
  });

// Every key that would narrate HOW a price was produced. complexity.reasoning is
// deliberately NOT here — see the note on shapeDecorAnalysis.
const METHOD_KEYS = [
  "observedBand", "comparables", "sizeBasis", "suggestedBand", "priceRange",
  "upliftApplied", "bandPosition", "headroomApplied", "pricingModel",
  "floralRatePerFt", "ratePerSqFt", "structure", "thresholdFt", "areaSqFt",
  "widthBasis", "spanWidthFt", "sceneType", "sceneWidthBand", "widthDisputed",
  "floralCoverageFraction", "rawHeightEstimateFt", "widthToHeightRatio",
  "structureGeometry", "lowConfidence", "fallbacks", "analysisMode",
];
const keysDeep = (v, acc = new Set()) => {
  if (Array.isArray(v)) { v.forEach((x) => keysDeep(x, acc)); return acc; }
  if (v && typeof v === "object") for (const [k, val] of Object.entries(v)) { acc.add(k); keysDeep(val, acc); }
  return acc;
};

const STAGE_M = readStageMeasurements({
  spanWidthFt: 24, floralRunFt: 19, confidence: 0.6,
  repeatingElements: { count: 4, estimatedWidthEachFt: 6 },
  widthToHeightRatio: 3, structureGeometry: "blocky", sceneType: "wide_venue_shot",
  reasoning: "four bays across the span",
});
const COPY = {
  suggestedName: "Ivory Cascade", description: "A dreamy peach embrace.", tags: ["floral", "romantic"],
  included: ["Decor as shown in image"], category: CAT,
  style: "Modern", colors: ["ivory"], flowers: ["roses"], fabric: ["Satin"],
};
DecorDraftService.__deps.storeRemoteImage = async ({ id }) => ({ url: `https://s3.test/${id}.jpg`, buffer: Buffer.from("x") });
DecorDraftService.__deps.toAnalysisBase64 = async () => "B64";
DecorDraftService.__deps.buildListingContext = async () => ({ existingNames: [], attributeOptions: {}, scopedTo: null });
DecorDraftService.__deps.analyseForCopy = async () => JSON.parse(JSON.stringify(COPY));
DecorDraftService.__deps.runPricingBrain = async () => ({
  analysis: {
    isDecorProduct: true, category: CAT, categoryConfidence: 0.92, style: "Modern",
    size: { length: 24, width: 16, confidence: 0.8 },
    complexity: { tier: "elaborate", confidence: 0.7, reasoning: "heavy floral coverage across six bays" },
    stageMeasurements: JSON.parse(JSON.stringify(STAGE_M)),
    recommendedSize: "24x16",
    occasion: { value: "reception", confidence: 0.8 },
    minBuildWidth: { minWidthFt: 20, reasoning: "spans four sofas", confidence: 0.7 },
    observations: ["heavy florals", "regular square structure"],
    ...COPY,
  },
  pricing: {
    category: CAT, applicableTiers: ["artificial", "mixed", "natural"],
    suggested: { artificial: 60000, mixed: 73000, natural: 86000 },
    observedBand: { min: 1, p25: 2, median: 3, p75: 4, max: 5, n: 12 },
    upliftApplied: 1.2,
    comparables: [{ id: "st001", artificial: 59000 }],
    sizeBasis: { area: 384, bucket: 384, naturalMedian: 86000 },
  },
  fallbacks: ["size: low confidence"], rejected: false, analysisMode: "full",
});

const drafts = [], decors = [];
(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  try {
    // ── 1. THE SOURCE STAMP ─────────────────────────────────────────────────
    console.log("1. Decor.source marks extension-added products");
    const d1 = await DecorDraftService.createDraft(
      { imageUrl: `https://i.pinimg.com/564x/ab/cd/${TAG}1.jpg`, pinId: `${TAG}-1`, pinText: "stage" }, null
    );
    drafts.push(d1._id);
    const r1 = await DecorDraftService.approveDraft(d1._id, {
      category: CAT, name: "Ivory Cascade", productCode: `${TAG}c1`,
      productTypes: [
        { name: "Artificial Flowers", sellingPrice: 66000, overridden: true, reason: "denser than the AI read" },
        { name: "Natural Flowers", sellingPrice: 86000 },
      ],
    }, null);
    decors.push(r1.decorId);
    const published = await Decor.findById(r1.decorId).lean();
    eq(published.source, "extension", "approve stamps source = extension");

    const manual = await Decor.create({
      category: CAT, name: `${TAG} manual`, unit: "Pc",
      image: "https://s3.test/m.jpg", thumbnail: "https://s3.test/m.jpg",
      productInfo: { id: `${TAG}m1` },
    });
    decors.push(manual._id);
    eq(manual.source, "", "a manually-created product leaves source UNSET — no backfill needed");

    // it survives a tags edit, which a tag-string marker would not
    await Decor.updateOne({ _id: r1.decorId }, { $set: { tags: [] } });
    const afterEdit = await Decor.findById(r1.decorId).lean();
    eq(afterEdit.source, "extension", "…and survives an approver wiping the tags");

    // ── 2. THE FILTER ───────────────────────────────────────────────────────
    console.log("\n2. GET /decor?source=extension");
    const filtered = await call(decor.GetAll, { query: { source: "extension", category: CAT, limit: "200" } });
    eq(filtered.status, 200, "the filter is accepted");
    const ids = (filtered.body.list || []).map((x) => String(x._id));
    ok(ids.includes(String(r1.decorId)), "…returns the extension-added product");
    ok(!ids.includes(String(manual._id)), "…and excludes the manually-added one");
    ok((filtered.body.list || []).every((x) => x.source === "extension"), "…every row carries the stamp");
    const unfiltered = await call(decor.GetAll, { query: { category: CAT, limit: "200" } });
    ok((unfiltered.body.list || []).length >= (filtered.body.list || []).length,
      "…and omitting the filter does not narrow the list");

    // ── 3. THE ANALYSIS LOOKUP ──────────────────────────────────────────────
    console.log("\n3. GET /decor/:_id/analysis");
    const got = await call(decor.DecorAnalysis, { params: { _id: String(r1.decorId) } });
    eq(got.status, 200, "returns 200 for an extension-added product");
    const b = got.body;
    eq(b.draftId, String(d1._id), "links back to the draft it came from");
    eq(b.category, CAT, "category");
    eq(b.categoryConfidence, 0.92, "category confidence");
    eq(b.style, "Modern", "style");
    eq(b.complexity.tier, "elaborate", "complexity tier");
    eq(b.complexity.reasoning, "heavy floral coverage across six bays",
      "complexity REASONING kept — the endpoint exists to show why (deliberate departure)");
    eq(JSON.stringify(b.size), JSON.stringify({ length: 24, width: 16 }), "size, without its confidence gate");
    eq(b.recommendedSize, "24x16", "recommended size");
    eq(b.occasion.value, "reception", "occasion value");
    eq(b.minBuildWidth.minWidthFt, 20, "min build width, value only");
    eq(b.observations.length, 2, "observations");
    eq(b.measurements.backdropWidthFt, 24, "measurements — backdrop width");
    eq(b.measurements.estimatedHeightFt, STAGE_M.estimatedHeightFt, "…height");
    eq(b.measurements.floralRunFt, 19, "…floral run");
    eq(b.measurements.repeatingElements.count, 4, "…repeating elements");
    eq(b.priceLadder.suggested.mixed, 73000, "the AI price ladder");
    eq(b.priceLadder.applicableTiers.length, 3, "…and which tiers applied");
    eq(b.copy.name, "Ivory Cascade", "the copy the AI wrote — name");
    eq(b.copy.description, "A dreamy peach embrace.", "…description");
    eq(b.copy.tags.length, 2, "…tags");
    eq(b.copy.flowers[0], "roses", "…flowers");

    // the decision half
    ok(!!b.decision.approvedAt, "records when it was approved");
    eq(b.decision.tierDecisions.length, 2, "…and the per-tier comparison");
    eq(b.decision.tierDecisions[0].aiSuggested, 60000, "AI suggested for that tier");
    eq(b.decision.tierDecisions[0].finalPrice, 66000, "…what was published");
    eq(b.decision.tierDecisions[0].overridden, true, "…flagged overridden");
    eq(b.decision.tierDecisions[0].reason, "denser than the AI read", "…with the reason");
    eq(b.decision.tierDecisions[0].deltaPct, 10, "…and the delta");
    eq(b.decision.tierDecisions[1].overridden, false, "the accepted tier is recorded too");

    // ── 4. THE TRIM ─────────────────────────────────────────────────────────
    console.log("\n4. no method leakage");
    const leaked = METHOD_KEYS.filter((k) => keysDeep(b).has(k));
    ok(leaked.length === 0, `no method keys on the wire${leaked.length ? ` — LEAKED: ${leaked.join(", ")}` : ""}`);
    const rawDraft = await DecorDraft.findById(d1._id).lean();
    ok(rawDraft.aiAnalysis.pricing.pricing.observedBand.n === 12,
      "…while the DRAFT still stores everything untrimmed (the trim is at the boundary)");
    ok(!!rawDraft.aiAnalysis.pricing.pricing.comparables, "…comparables survive on the draft");

    // it is a READ, not a copy
    ok(published.aiAnalysis === undefined, "nothing was copied onto the Decor document");

    // ── 5. THE MISS ─────────────────────────────────────────────────────────
    console.log("\n5. a manually-added product misses cleanly");
    const miss = await call(decor.DecorAnalysis, { params: { _id: String(manual._id) } });
    eq(miss.status, 404, "404 for a product with no draft");
    eq(miss.body.code, "NO_DRAFT", "…with a stable code the catalogue can branch on");
    ok(/wasn't added from the extension/i.test(miss.body.message), "…and a message that explains rather than alarms");

    const bad = await call(decor.DecorAnalysis, { params: { _id: "not-an-id" } });
    eq(bad.status, 400, "a malformed id is 400, distinct from the 404 miss");
    ok(bad.body.code !== "NO_DRAFT", "…and does NOT carry NO_DRAFT, so the tab logic can't confuse them");

    const gone = await call(decor.DecorAnalysis, { params: { _id: String(new mongoose.Types.ObjectId()) } });
    eq(gone.status, 404, "an unknown but valid id is also a clean 404");
    eq(gone.body.code, "NO_DRAFT", "…same code");
  } catch (e) {
    fail++; console.error("  ✗ threw:", e);
  } finally {
    await DecorDraft.deleteMany({ _id: { $in: drafts } });
    await Decor.deleteMany({ _id: { $in: decors } });
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
