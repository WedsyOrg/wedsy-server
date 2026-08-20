/**
 * A2S APPROVE — full product payload, per-tier learning record, and the
 * measurements bug.
 *
 * Covers the 2026-08-20 rework:
 *   · productTypes[] published as-is, validated per row
 *   · pricing.tierDecisions — what the AI suggested vs what the human set, per tier
 *   · productVisibility/Availability TRUE on approve
 *   · seoTags never written
 *   · pass-through fields
 *   · toCatalogueMeasurements: stageMeasurements → {length,width,height,area}
 *
 * The AI edges are stubbed via DecorDraftService.__deps — no Anthropic, no S3.
 *
 *   node tests/a2s-approve-payload.test.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

const DecorDraft = require("../models/DecorDraft");
const Decor = require("../models/Decor");
const DecorDraftService = require("../services/DecorDraftService");
const { readStageMeasurements } = require("../services/decorDemoPrice");

const TAG = `apv-${Date.now()}`;
const CAT = "Stage";
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${JSON.stringify(got)} vs ${JSON.stringify(want)})`);
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const FAKE_COPY = {
  suggestedName: "Ivory Cascade", description: "d", tags: ["floral"],
  included: ["Decor as shown in image"], category: CAT,
  style: "Modern", colors: ["ivory"], flowers: ["roses"], fabric: [],
};
// A cache-hit-shaped analysis: stageMeasurements and NO length/width. This is
// the exact shape that used to publish a zero-measurement product.
const STAGE_M = readStageMeasurements({
  spanWidthFt: 26, floralRunFt: 20, confidence: 0.6,
  repeatingElements: { count: 4, estimatedWidthEachFt: 6.5 },
  widthToHeightRatio: 3, structureGeometry: "blocky", reasoning: "four bays",
});
const FAKE_PRICING = () => ({
  analysis: {
    isDecorProduct: true, category: CAT, categoryConfidence: 0.9, style: "Modern",
    size: { length: 24, width: 16, confidence: 0.8 },
    complexity: { tier: "standard", confidence: 0.7, reasoning: "balanced" },
    stageMeasurements: JSON.parse(JSON.stringify(STAGE_M)),
    ...FAKE_COPY,
  },
  pricing: {
    category: CAT, applicableTiers: ["artificial", "mixed", "natural"],
    suggested: { artificial: 60000, mixed: 73000, natural: 86000 },
  },
  fallbacks: [], rejected: false,
});

DecorDraftService.__deps.storeRemoteImage = async ({ id }) => ({ url: `https://s3.test/${id}.jpg`, buffer: Buffer.from("x") });
DecorDraftService.__deps.toAnalysisBase64 = async () => "B64";
DecorDraftService.__deps.buildListingContext = async () => ({ existingNames: [], attributeOptions: {}, scopedTo: null });
DecorDraftService.__deps.runPricingBrain = async () => FAKE_PRICING();
DecorDraftService.__deps.analyseForCopy = async () => JSON.parse(JSON.stringify(FAKE_COPY));

const drafts = [], decors = [];
let n = 0;
const newDraft = async () => {
  n += 1;
  const d = await DecorDraftService.createDraft(
    { imageUrl: `https://i.pinimg.com/564x/ab/cd/${TAG}${n}.jpg`, pinId: `${TAG}-${n}`, pinText: "stage" },
    null
  );
  drafts.push(d._id);
  return d;
};

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  try {
    // ── 1. THE MEASUREMENTS BUG ─────────────────────────────────────────────
    console.log("1. stageMeasurements → catalogue measurements");
    const { toCatalogueMeasurements, measurementsFromAnalysis } = DecorDraftService;
    eq(Number(STAGE_M.length) || 0, 0, "the vision payload genuinely has NO length (the bug's cause)");
    eq(STAGE_M.backdropWidthFt, 26, "…only a counted backdropWidthFt");

    const m = toCatalogueMeasurements(STAGE_M);
    eq(m.length, 24, "length ← backdropWidthFt 26ft snapped to the nearest rung (24)");
    eq(m.width, 16, "width ← that SAME rung's width, never mixed from another source");
    eq(m.height, STAGE_M.estimatedHeightFt, "height ← estimatedHeightFt, passed through");
    eq(m.area, 384, "area computed as length × width");
    ok(m.length > 0 && m.width > 0, "…so the product is size-matchable instead of excluded");

    const passthru = toCatalogueMeasurements({ length: 30, width: 16, height: 12 });
    eq(passthru.length, 30, "a catalogue-shaped input passes through UNSNAPPED");
    eq(passthru.area, 480, "…with area filled in");
    eq(toCatalogueMeasurements({}).length, 0, "an empty payload stays zero rather than inventing a size");
    eq(measurementsFromAnalysis({ size: { length: 24, width: 16 } }).length, 24, "cache-miss draft (size only) still works");
    eq(measurementsFromAnalysis({ stageMeasurements: STAGE_M, size: { length: 8, width: 8 } }).length, 24,
      "when BOTH exist the COUNTED backdrop wins, not the snapped guess");

    const d0 = await newDraft();
    eq(d0.suggested.measurements.length, 24, "a cache-hit draft pre-fills a real length");
    eq(d0.suggested.measurements.width, 16, "…and a real width");

    // ── 2. ALL THREE TIERS PUBLISH ──────────────────────────────────────────
    console.log("\n2. every tier the approver kept is published as-is");
    const d1 = await newDraft();
    const r1 = await DecorDraftService.approveDraft(d1._id, {
      category: CAT, name: "Ivory Cascade", productCode: `${TAG}a1`,
      productTypes: [
        { name: "Artificial Flowers", sellingPrice: 60000, costPrice: 25000, discount: 10 },
        { name: "Mixed Flowers", sellingPrice: 80000, overridden: true, reason: "denser florals than the AI read" },
        { name: "Natural Flowers", sellingPrice: 86000 },
      ],
    }, null);
    decors.push(r1.decorId);
    const p1 = await Decor.findById(r1.decorId).lean();
    eq(p1.productTypes.length, 3, "all three rows published");
    eq(p1.productTypes[0].name, "Artificial Flowers", "row names preserved verbatim");
    eq(p1.productTypes[0].costPrice, 25000, "costPrice published");
    eq(p1.productTypes[0].discount, 10, "discount published");
    eq(p1.productTypes[1].sellingPrice, 80000, "the human's override is the published price");
    eq(p1.productVisibility, true, "goes LIVE on approve — visibility");
    eq(p1.productAvailability, true, "…and availability");
    eq(p1.productInfo.measurements.length, 24, "…with real measurements, not zeros");
    ok(!p1.seoTags || !p1.seoTags.title, "seoTags never written — `tags` is the only tag surface");

    // ── 3. THE PER-TIER LEARNING RECORD ─────────────────────────────────────
    console.log("\n3. pricing.tierDecisions records AI vs human, per tier");
    const td = r1.draft.pricing.tierDecisions;
    eq(td.length, 3, "one entry per published row");
    eq(td[0].tier, "artificial", "row name mapped to a tier key");
    eq(td[0].aiSuggested, 60000, "…carrying what the AI ladder suggested for THAT tier");
    eq(td[0].finalPrice, 60000, "…and what the human set");
    eq(td[0].overridden, false, "accepting the AI price is recorded as not-overridden");
    eq(td[0].deltaPct, 0, "…delta 0%");
    eq(td[1].tier, "mixed", "second row mapped");
    eq(td[1].aiSuggested, 73000, "…AI figure for mixed");
    eq(td[1].finalPrice, 80000, "…human figure");
    eq(td[1].overridden, true, "…flagged as overridden");
    eq(td[1].reason, "denser florals than the AI read", "…with the reason kept against THAT tier");
    eq(td[1].deltaPct, 9.6, "…and the delta computed");
    ok(td.every((t) => t.panelQuote === null), "panelQuote is null where the panel never quoted that tier");

    // the legacy fields keep their old meaning
    eq(r1.draft.pricing.finalPrice, 60000, "legacy finalPrice = the HEADLINE row, unchanged in meaning");
    eq(r1.draft.pricing.overridden, true, "legacy overridden = any tier overridden");
    ok(/1 of 3 tier\(s\) overridden/.test(r1.draft.history[r1.draft.history.length - 1].note), "history names how many tiers moved");

    // the "before" evidence is untouched
    const reload = await DecorDraft.findById(d1._id).lean();
    eq(reload.pricing.aiSuggested.suggested.mixed, 73000, "pricing.aiSuggested is untouched by approval");
    const eImm = await threw(() => DecorDraft.updateOne({ _id: d1._id }, { $set: { "pricing.aiSuggested.suggested.mixed": 1 } }));
    ok(eImm && /immutable/i.test(eImm.message), "…and still immutable");

    // ── 4. PER-ROW VALIDATION ───────────────────────────────────────────────
    console.log("\n4. per-row validation");
    const d2 = await newDraft();
    const base = { category: CAT, name: "X", productCode: `${TAG}a2` };
    const bad = async (productTypes, label, rx) => {
      const e = await threw(() => DecorDraftService.approveDraft(d2._id, { ...base, productTypes }, null));
      ok(e && e.status === 400 && rx.test(e.message), `${label} → 400 (${e && e.message})`);
    };
    await bad([], "empty array", /must not be empty/i);
    await bad([{ name: "", sellingPrice: 100 }], "blank name", /name is required/i);
    await bad([{ name: "Price", sellingPrice: 0 }], "zero sellingPrice", /sellingPrice/i);
    await bad([{ name: "Price", sellingPrice: -5 }], "negative sellingPrice", /sellingPrice/i);
    await bad([{ name: "Price", sellingPrice: 100, costPrice: -1 }], "negative costPrice", /costPrice/i);
    await bad([{ name: "Price", sellingPrice: 100, discount: 101 }], "discount > 100", /discount/i);
    await bad([{ name: "Price", sellingPrice: 100, discount: -1 }], "discount < 0", /discount/i);
    await bad([{ name: "Price", sellingPrice: 100, overridden: true }], "override with no reason", /reason is required/i);
    const eSecond = await threw(() => DecorDraftService.approveDraft(d2._id, {
      ...base, productTypes: [{ name: "Artificial Flowers", sellingPrice: 100 }, { name: "Mixed Flowers", sellingPrice: 0 }],
    }, null));
    ok(eSecond && /row 2 \("Mixed Flowers"\)/.test(eSecond.message), "the error names WHICH row failed");
    const stillQueued = await DecorDraft.findById(d2._id).lean();
    eq(stillQueued.status, "queued", "a rejected payload leaves the draft queued — nothing half-published");
    eq(await Decor.countDocuments({ "productInfo.id": `${TAG}a2` }), 0, "…and writes no product");

    // a top-level reason still covers every row
    const okTop = await DecorDraftService.approveDraft(d2._id, {
      ...base, reason: "founder repriced the whole build",
      productTypes: [{ name: "Artificial Flowers", sellingPrice: 70000, overridden: true }],
    }, null);
    decors.push(okTop.decorId);
    eq(okTop.draft.pricing.tierDecisions[0].reason, "founder repriced the whole build", "a top-level reason covers a row that has none");

    // ── 5. PASS-THROUGH + EMPTY-TIER CATEGORIES ─────────────────────────────
    console.log("\n5. pass-through fields and a category with no pre-fillable tiers");
    const d3 = await newDraft();
    const r3 = await DecorDraftService.approveDraft(d3._id, {
      category: "Partitions", name: "Screen", productCode: `${TAG}a3`,
      unit: "Set", label: "BestSeller", video: "https://v/x.mp4",
      additionalImages: ["https://s3.test/2.jpg"],
      attributes: [{ name: "Style", list: ["Modern"] }],
      productVariation: { colors: ["white"], style: "Modern" },
      productVariants: [{ name: "wide", priceModifier: 5000 }],
      rawMaterials: [{ name: "MDF", quantity: 4 }],
      measurements: { length: 12, width: 2, height: 8 },
      // Partitions has an EMPTY Category.productTypes list — the approver types it.
      productTypes: [{ name: "Price", sellingPrice: 40000 }],
    }, null);
    decors.push(r3.decorId);
    const p3 = await Decor.findById(r3.decorId).lean();
    eq(p3.unit, "Set", "unit passed through");
    eq(p3.label, "BestSeller", "label passed through");
    eq(p3.video, "https://v/x.mp4", "video passed through");
    eq(p3.additionalImages.length, 1, "additionalImages passed through");
    eq(p3.attributes[0].name, "Style", "attributes passed through");
    eq(p3.productVariation.style, "Modern", "productVariation passed through");
    eq(p3.productVariants[0].priceModifier, 5000, "productVariants passed through");
    eq(p3.rawMaterials[0].name, "MDF", "rawMaterials passed through");
    eq(p3.productInfo.measurements.length, 12, "an explicit measurement wins over the draft's");
    eq(r3.draft.pricing.tierDecisions[0].tier, "flat", '"Price" maps to the flat tier');
    eq(r3.draft.pricing.tierDecisions[0].aiSuggested, null, "…with no AI figure for a tier the ladder never priced");
    eq(r3.draft.pricing.tierDecisions[0].deltaPct, null, "…and no delta invented from it");

    // ── 6. THE DEPRECATED FALLBACK STILL WORKS ──────────────────────────────
    console.log("\n6. legacy finalPrice body (deploy-ordering safety net)");
    const d4 = await newDraft();
    const r4 = await DecorDraftService.approveDraft(d4._id, {
      category: CAT, name: "Legacy", productCode: `${TAG}a4`, finalPrice: 55000, overridden: false,
    }, null);
    decors.push(r4.decorId);
    const p4 = await Decor.findById(r4.decorId).lean();
    eq(p4.productTypes.length, 1, "a legacy body still publishes one row");
    eq(p4.productTypes[0].sellingPrice, 55000, "…at the price it sent");
    eq(r4.draft.pricing.tierDecisions.length, 1, "…and still records a tier decision");
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
