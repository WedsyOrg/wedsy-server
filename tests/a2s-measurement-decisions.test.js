/**
 * measurementDecisions — dimension corrections keep their reason (2026-08-20).
 *
 * THE BUG: pricing.reason derived exclusively from an overridden TIER, so an
 * approver who changed only the height got reason "" and their explanation was
 * discarded silently.
 *
 * Covers: the server-side aiRead, the reason requirement, the shared reason
 * across price and size, that pricing.overridden still means PRICE, that
 * measurementDecisions never contaminates tierDecisions[0] (which sets the
 * product's price), and the /analysis response.
 *
 *   node tests/a2s-measurement-decisions.test.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

const DecorDraft = require("../models/DecorDraft");
const Decor = require("../models/Decor");
const DecorDraftService = require("../services/DecorDraftService");
const decor = require("../controllers/decor");
const { readStageMeasurements } = require("../services/decorDemoPrice");

const TAG = `md-${Date.now()}`;
const CAT = "Stage";
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${JSON.stringify(got)} vs ${JSON.stringify(want)})`);
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const call = (handler, params) =>
  new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, send(b) { resolve({ status: this.statusCode, body: b }); }, json(b) { resolve({ status: this.statusCode, body: b }); } };
    Promise.resolve(handler({ params, query: {}, body: {} }, res)).catch((e) => resolve({ status: 500, body: { message: e.message } }));
  });

// AI reads a 24ft backdrop → 24x16, height 10 (see toCatalogueMeasurements).
const STAGE_M = readStageMeasurements({
  spanWidthFt: 24, floralRunFt: 19, confidence: 0.6,
  repeatingElements: { count: 4, estimatedWidthEachFt: 6 },
  widthToHeightRatio: 3, structureGeometry: "blocky", reasoning: "four bays",
});
const COPY = { suggestedName: "Ivory Cascade", description: "d", tags: [], included: [], category: CAT, style: "Modern", colors: [], flowers: [], fabric: [] };
DecorDraftService.__deps.storeRemoteImage = async ({ id }) => ({ url: `https://s3.test/${id}.jpg`, buffer: Buffer.from("x") });
DecorDraftService.__deps.toAnalysisBase64 = async () => "B64";
DecorDraftService.__deps.buildListingContext = async () => ({ existingNames: [], attributeOptions: {}, scopedTo: null });
DecorDraftService.__deps.analyseForCopy = async () => JSON.parse(JSON.stringify(COPY));
DecorDraftService.__deps.runPricingBrain = async () => ({
  analysis: {
    isDecorProduct: true, category: CAT, categoryConfidence: 0.9, style: "Modern",
    size: { length: 24, width: 16, confidence: 0.8 },
    complexity: { tier: "standard", confidence: 0.7, reasoning: "r" },
    stageMeasurements: JSON.parse(JSON.stringify(STAGE_M)), ...COPY,
  },
  pricing: { category: CAT, applicableTiers: ["artificial", "mixed"], suggested: { artificial: 60000, mixed: 73000 } },
  fallbacks: [], rejected: false,
});

const drafts = [], decors = [];
let n = 0;
const newDraft = async () => {
  n += 1;
  const d = await DecorDraftService.createDraft({ imageUrl: `https://i.pinimg.com/564x/ab/cd/${TAG}${n}.jpg`, pinId: `${TAG}-${n}`, pinText: "stage" }, null);
  drafts.push(d._id);
  return d;
};
const ROW = [{ name: "Artificial Flowers", sellingPrice: 60000 }];

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  try {
    // ── 1. THE BUG THIS FIXES ───────────────────────────────────────────────
    console.log("1. a dimension-only correction keeps its reason");
    const d1 = await newDraft();
    eq(d1.suggested.measurements.height, 10, "the AI read height 10");
    const r1 = await DecorDraftService.approveDraft(d1._id, {
      category: CAT, name: "X", productCode: `${TAG}c1`,
      productTypes: ROW, // price ACCEPTED as-is
      measurements: { length: 24, width: 16, height: 12 }, // only the height moves
      reason: "measured on site — the panels are 12ft",
    }, null);
    decors.push(r1.decorId);
    eq(r1.draft.pricing.reason, "measured on site — the panels are 12ft",
      "pricing.reason SURVIVES — before this it was \"\" and the explanation was lost");
    eq(r1.draft.pricing.overridden, false,
      "pricing.overridden stays FALSE — it still means the PRICE was overridden");
    const md1 = r1.draft.pricing.measurementDecisions;
    eq(md1.length, 3, "one entry per dimension");
    const h = md1.find((m) => m.field === "height");
    eq(h.aiRead, 10, "height aiRead from the analysis");
    eq(h.finalValue, 12, "…final value");
    eq(h.overridden, true, "…flagged as corrected");
    eq(h.reason, "measured on site — the panels are 12ft", "…carrying the shared reason");
    eq(h.deltaPct, 20, "…and the delta");
    ok(md1.filter((m) => m.field !== "height").every((m) => !m.overridden), "the untouched dimensions are not flagged");
    ok(md1.filter((m) => m.field !== "height").every((m) => m.reason === ""), "…and carry no reason");
    ok(/corrected height/.test(r1.draft.history[r1.draft.history.length - 1].note), "history names the corrected dimension");
    const pub1 = await Decor.findById(r1.decorId).lean();
    eq(pub1.productInfo.measurements.height, 12, "the human's height is what publishes");
    eq(pub1.productTypes.length, 1, "…and the price rows are untouched by any of this");
    eq(pub1.productTypes[0].sellingPrice, 60000, "…at the accepted AI price");

    // ── 2. THE REASON IS REQUIRED ───────────────────────────────────────────
    console.log("\n2. a correction without a reason is refused");
    const d2 = await newDraft();
    const e2 = await threw(() => DecorDraftService.approveDraft(d2._id, {
      category: CAT, name: "X", productCode: `${TAG}c2`, productTypes: ROW,
      measurements: { length: 24, width: 16, height: 12 },
    }, null));
    ok(e2 && e2.status === 400, "400 when a dimension moved with no reason");
    ok(/reason is required/i.test(e2.message) && /height/.test(e2.message), `…naming the dimension (${e2.message})`);
    eq((await DecorDraft.findById(d2._id).lean()).status, "queued", "…and the draft is left queued");
    eq(await Decor.countDocuments({ "productInfo.id": `${TAG}c2` }), 0, "…with nothing published");

    const e2b = await threw(() => DecorDraftService.approveDraft(d2._id, {
      category: CAT, name: "X", productCode: `${TAG}c2`, productTypes: ROW,
      measurements: { length: 30, width: 16, height: 12 }, reason: "   ",
    }, null));
    ok(e2b && e2b.status === 400 && /length, height/.test(e2b.message), "whitespace is not a reason, and every moved dimension is named");

    // matching the AI read needs no reason
    const okSame = await DecorDraftService.approveDraft(d2._id, {
      category: CAT, name: "X", productCode: `${TAG}c2`, productTypes: ROW,
      measurements: { length: 24, width: 16, height: 10 },
    }, null);
    decors.push(okSame.decorId);
    ok(okSame.draft.pricing.measurementDecisions.every((m) => !m.overridden), "agreeing with the AI needs no reason");
    eq(okSame.draft.pricing.reason, "", "…and records no reason");

    // ── 3. aiRead IS SERVER-SIDE ────────────────────────────────────────────
    console.log("\n3. the \"before\" half is never taken from the request");
    const d3 = await newDraft();
    const r3 = await DecorDraftService.approveDraft(d3._id, {
      category: CAT, name: "X", productCode: `${TAG}c3`, productTypes: ROW,
      measurements: { length: 24, width: 16, height: 12 },
      reason: "site measurement",
      // A client trying to make its own correction look like an agreement.
      measurementDecisions: [{ field: "height", aiRead: 12, finalValue: 12, overridden: false, reason: "" }],
    }, null);
    decors.push(r3.decorId);
    const h3 = r3.draft.pricing.measurementDecisions.find((m) => m.field === "height");
    eq(h3.aiRead, 10, "aiRead comes from the immutable aiAnalysis, NOT the body");
    eq(h3.overridden, true, "…so the correction cannot be disguised as an agreement");
    eq(r3.draft.pricing.measurementDecisions.length, 3, "a client-supplied array is ignored entirely");

    // and it reads the ANALYSIS, not the mutable draft pre-fill
    const d3b = await newDraft();
    await DecorDraft.updateOne({ _id: d3b._id }, { $set: { "draft.measurements.height": 15 } });
    const r3b = await DecorDraftService.approveDraft(d3b._id, {
      category: CAT, name: "X", productCode: `${TAG}c3b`, productTypes: ROW,
      measurements: { length: 24, width: 16, height: 15 }, reason: "kept the edited height",
    }, null);
    decors.push(r3b.decorId);
    eq(r3b.draft.pricing.measurementDecisions.find((m) => m.field === "height").aiRead, 10,
      "an earlier edit to draft.measurements does NOT become the AI's reading");

    // ── 4. ONE SHARED REASON, BOTH HALVES ───────────────────────────────────
    console.log("\n4. one reason covers price and size together");
    const d4 = await newDraft();
    const r4 = await DecorDraftService.approveDraft(d4._id, {
      category: CAT, name: "X", productCode: `${TAG}c4`,
      productTypes: [{ name: "Artificial Flowers", sellingPrice: 75000 }],
      measurements: { length: 32, width: 16, height: 12 },
      overridden: true,
      reason: "bigger build than the AI read, repriced to match",
    }, null);
    decors.push(r4.decorId);
    eq(r4.draft.pricing.overridden, true, "a real price override still sets overridden");
    eq(r4.draft.pricing.reason, "bigger build than the AI read, repriced to match", "…and the shared reason is recorded once");
    eq(r4.draft.pricing.tierDecisions[0].reason, r4.draft.pricing.reason, "the tier carries it");
    eq(r4.draft.pricing.measurementDecisions.find((m) => m.field === "length").reason, r4.draft.pricing.reason, "…and so does the dimension");
    eq(r4.draft.pricing.tierDecisions[0].deltaPct, 25, "the tier delta is still computed independently");
    eq(r4.draft.pricing.measurementDecisions.find((m) => m.field === "length").deltaPct, 33.3, "…as is the dimension delta");

    // ── 5. IT CANNOT CONTAMINATE THE PRICE ──────────────────────────────────
    console.log("\n5. measurementDecisions is a SIBLING, never a tier row");
    ok(Array.isArray(r4.draft.pricing.tierDecisions) && Array.isArray(r4.draft.pricing.measurementDecisions), "two separate arrays");
    ok(r4.draft.pricing.tierDecisions.every((t) => !["length", "width", "height"].includes(t.tier)),
      "no dimension ever appears in tierDecisions — tierDecisions[0] sets the product price");
    eq(r4.draft.pricing.finalPrice, 75000, "finalPrice still comes from the first PRICE row");
    ok(r4.draft.pricing.measurementDecisions.every((m) => m.finalPrice === undefined), "dimension entries carry no price field at all");

    // ── 6. THE /analysis RESPONSE ───────────────────────────────────────────
    console.log("\n6. GET /decor/:_id/analysis returns both records");
    const an = await call(decor.DecorAnalysis, { _id: String(r4.decorId) });
    eq(an.status, 200, "analysis returns");
    eq(an.body.decision.measurementDecisions.length, 3, "measurementDecisions alongside tierDecisions");
    const anL = an.body.decision.measurementDecisions.find((m) => m.field === "length");
    eq(anL.aiRead, 24, "…aiRead on the wire");
    eq(anL.finalValue, 32, "…finalValue");
    eq(anL.overridden, true, "…overridden");
    eq(anL.deltaPct, 33.3, "…deltaPct");
    eq(anL.reason, "bigger build than the AI read, repriced to match", "…and the reason");
    ok(an.body.decision.tierDecisions.length === 1, "tierDecisions is untouched by the addition");
  } catch (e) {
    fail++; console.error("  ✗ threw:", e);
  } finally {
    await DecorDraft.deleteMany({ _id: { $in: drafts } });
    await Decor.deleteMany({ _id: { $in: decors.filter(Boolean) } });
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
