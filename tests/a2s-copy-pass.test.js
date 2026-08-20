/**
 * A2S FAST RETURN — image secured first, copy written after (2026-08-20).
 *
 * Covers: the deferred copy on the cache-hit path, copy.status as a third state
 * beside `status`, restart safety, approval never blocked, the retry endpoint,
 * and the constraint that forced the design — aiAnalysis is immutable, so the
 * late copy cannot be patched into it and lives in copyAnalysis instead.
 *
 * scheduleCopyPass is stubbed so the deferred work is driven deterministically
 * rather than raced against setImmediate.
 *
 *   node tests/a2s-copy-pass.test.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

const DecorDraft = require("../models/DecorDraft");
const Decor = require("../models/Decor");
const DecorImageRead = require("../models/DecorImageRead");
const DecorDraftService = require("../services/DecorDraftService");
const decorDraft = require("../controllers/decorDraft");
const { postProcess } = require("../services/decorVision");

const TAG = `cp-${Date.now()}`;
const CAT = "Stage";
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${JSON.stringify(got)} vs ${JSON.stringify(want)})`);
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const call = (handler, params) =>
  new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, send(b) { resolve({ status: this.statusCode, body: b }); }, json(b) { resolve({ status: this.statusCode, body: b }); } };
    Promise.resolve(handler({ params, body: {}, query: {} }, res)).catch((e) => resolve({ status: 500, body: { message: e.message } }));
  });

const COPY = {
  suggestedName: "Ivory Cascade", description: "A dreamy peach embrace.",
  tags: ["floral", "romantic"], included: ["Decor as shown in image"],
  category: CAT, style: "Modern", colors: ["ivory"], flowers: ["roses"], fabric: ["Satin"],
};
let copyCalls = 0, copyBehaviour = "ok";
let scheduled = [];

DecorDraftService.__deps.storeRemoteImage = async ({ id }) => ({ url: `https://s3.test/${id}.jpg`, buffer: Buffer.from("original-buffer") });
DecorDraftService.__deps.fetchRemoteImage = async (url) => ({ buffer: Buffer.from(`refetched:${url}`) });
DecorDraftService.__deps.toAnalysisBase64 = async (buf) => `B64:${buf.toString()}`;
DecorDraftService.__deps.buildListingContext = async (cat) => ({ existingNames: [], attributeOptions: {}, scopedTo: cat || null });
DecorDraftService.__deps.analyseForCopy = async () => {
  copyCalls += 1;
  if (copyBehaviour === "throw") throw new Error("AI service error");
  return JSON.parse(JSON.stringify(COPY));
};
DecorDraftService.__deps.runPricingBrain = async () => ({
  analysis: { isDecorProduct: true, category: CAT, categoryConfidence: 0.9, style: "Modern",
    size: { length: 24, width: 16, confidence: 0.8 },
    complexity: { tier: "standard", confidence: 0.7, reasoning: "r" }, ...COPY },
  pricing: { category: CAT, applicableTiers: ["artificial"], suggested: { artificial: 60000 } },
  fallbacks: [], rejected: false,
});
// Capture instead of firing, so the "before the pass runs" window is inspectable.
DecorDraftService.__deps.scheduleCopyPass = (draftId, buffer) => { scheduled.push({ draftId, buffer }); };

const drafts = [], decors = [], reads = [];
let n = 0;
const IMG = () => `https://i.pinimg.com/564x/ab/cd/${TAG}${n}.jpg`;
const warmCache = async () => {
  const analysis = postProcess({
    isDecorProduct: true, category: CAT, categoryConfidence: 0.9, style: "Modern",
    size: { length: 24, width: 16, confidence: 0.9 },
    complexity: { tier: "standard", confidence: 0.9, reasoning: "r" },
    observations: [], recommendedSize: { length: 24, width: 16 },
    stageMeasurements: { spanWidthFt: 24, floralRunFt: 19, confidence: 0.6, repeatingElements: { count: 4, estimatedWidthEachFt: 6 }, widthToHeightRatio: 3, structureGeometry: "blocky", reasoning: "x" },
    occasion: { value: null, confidence: 0 },
  }, "demo");
  const e = await DecorImageRead.create({ pinId: `${TAG}-${n}`, normalizedUrl: require("../services/decorImageKey").normalizeImageUrl(IMG()), analysis, mode: "demo", firstReadAt: new Date() });
  reads.push(e._id);
};
const newDraft = async ({ cached }) => {
  n += 1;
  if (cached) await warmCache();
  const d = await DecorDraftService.createDraft({ imageUrl: IMG(), pinId: `${TAG}-${n}`, pinText: "stage" }, null);
  drafts.push(d._id);
  return d;
};

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  try {
    // ── 1. CACHE HIT — the reply does not wait for the copy ─────────────────
    console.log("1. cache hit: draft returns with the image and price, copy pending");
    copyCalls = 0; scheduled = [];
    const d1 = await newDraft({ cached: true });
    eq(copyCalls, 0, "createDraft made NO copy call — the staff member is not waiting on it");
    eq(d1.copy.status, "pending", "copy.status = pending");
    eq(d1.status, "queued", "…while `status` is still plain queued — a third state BESIDE it, not inside");
    ok(/^https:\/\/s3\.test\//.test(d1.storedImage), "the IRREPLACEABLE part is already secured in S3");
    ok(!!d1.pricing.aiSuggested.suggested, "…and the price ladder is already on the draft");
    eq(d1.suggested.name, "", "no copy yet");
    eq(d1.copyAnalysis, null, "…and no raw copy record");
    eq(scheduled.length, 1, "a copy pass was scheduled");
    eq(String(scheduled[0].draftId), String(d1._id), "…for this draft");
    ok(Buffer.isBuffer(scheduled[0].buffer), "…with the image buffer already in hand (no S3 round-trip)");

    // ── 2. THE PASS FILLS IT IN ─────────────────────────────────────────────
    console.log("\n2. the copy pass patches the draft afterwards");
    const res2 = await DecorDraftService.runCopyPass(scheduled[0].draftId, scheduled[0].buffer);
    eq(res2.status, "ready", "the pass reports ready");
    eq(copyCalls, 1, "…having made exactly one copy call");
    const after = await DecorDraft.findById(d1._id).lean();
    eq(after.copy.status, "ready", "copy.status flips to ready");
    eq(after.copy.attempts, 1, "…attempts recorded");
    ok(!!after.copy.completedAt, "…completedAt stamped");
    eq(after.suggested.name, "Ivory Cascade", "suggested.name written");
    eq(after.suggested.description, COPY.description, "…description");
    eq(after.draft.name, "Ivory Cascade", "draft.name filled for the approver");
    eq(after.copyAnalysis.suggestedName, "Ivory Cascade", "the raw copy record is stored in copyAnalysis");

    // THE CONSTRAINT THAT SHAPED THE DESIGN
    eq(after.aiAnalysis.listing, null, "aiAnalysis.listing stays NULL — it is immutable and cannot be patched");
    ok(!!after.aiAnalysis.pricing, "…while the pricing half written at create is intact");
    const eImm = await threw(() => DecorDraft.updateOne({ _id: d1._id }, { $set: { "aiAnalysis.listing": COPY } }));
    ok(eImm && /immutable/i.test(eImm.message), "…and still refuses to be written");

    // ── 3. CACHE MISS — nothing to defer ────────────────────────────────────
    console.log("\n3. cache miss: one merged call already returns the copy");
    copyCalls = 0; scheduled = [];
    const d3 = await newDraft({ cached: false });
    eq(d3.copy.status, "ready", "copy.status = ready straight away");
    eq(scheduled.length, 0, "…nothing scheduled");
    eq(copyCalls, 0, "…and no separate copy call was needed");
    eq(d3.suggested.name, "Ivory Cascade", "the copy is already on the draft");

    // ── 4. RESTART SAFETY ───────────────────────────────────────────────────
    console.log("\n4. a pm2 restart mid-copy leaves it in the needs-writing state");
    copyCalls = 0; scheduled = [];
    const d4 = await newDraft({ cached: true });
    // Simulate the process dying before the pass completes: nothing ran at all.
    const stranded = await DecorDraft.findById(d4._id).lean();
    eq(stranded.copy.status, "pending", "still pending — indistinguishable from never-started, which is correct");
    eq(stranded.copy.completedAt, null, "nothing half-written");
    ok(!!stranded.storedImage && !!stranded.pricing.aiSuggested, "the image and price survived the restart");
    // Recovery is a RE-RUN, not a repair — and without the original buffer.
    const res4 = await DecorDraftService.runCopyPass(d4._id, null);
    eq(res4.status, "ready", "re-running after a restart works");
    const rec = await DecorDraft.findById(d4._id).lean();
    eq(rec.suggested.name, "Ivory Cascade", "…and writes the copy");
    eq((await DecorDraft.findById(d4._id).lean()).copy.attempts, 1, "attempts counted from the successful run");

    // ── 5. APPROVAL IS NEVER BLOCKED ────────────────────────────────────────
    console.log("\n5. a pending / failed copy is FULLY approvable");
    copyCalls = 0; scheduled = [];
    const d5 = await newDraft({ cached: true });
    eq((await DecorDraft.findById(d5._id).lean()).copy.status, "pending", "draft has no copy");
    const e5 = await threw(() => DecorDraftService.approveDraft(d5._id, {
      category: CAT, productCode: `${TAG}p5`, productTypes: [{ name: "Artificial Flowers", sellingPrice: 60000 }],
    }, null));
    ok(e5 && e5.status === 400 && /hasn't been written yet/.test(e5.message), `a missing name explains WHY (${e5 && e5.message})`);
    // Rohaan types his own name — and it publishes.
    const r5 = await DecorDraftService.approveDraft(d5._id, {
      category: CAT, name: "Rohaan's Own Name", productCode: `${TAG}p5`,
      productTypes: [{ name: "Artificial Flowers", sellingPrice: 60000 }],
    }, null);
    decors.push(r5.decorId);
    eq(r5.draft.status, "approved", "approving with a pending copy WORKS");
    const pub5 = await Decor.findById(r5.decorId).lean();
    eq(pub5.name, "Rohaan's Own Name", "…publishing the human's copy");
    eq(pub5.productTypes[0].sellingPrice, 60000, "…at the approved price");

    // ── 6. FAILURE IS RECORDED, NOT SWALLOWED ───────────────────────────────
    console.log("\n6. a failed copy pass is visible and recoverable");
    copyCalls = 0; scheduled = [];
    const d6 = await newDraft({ cached: true });
    copyBehaviour = "throw";
    const res6 = await DecorDraftService.runCopyPass(d6._id, Buffer.from("x"));
    eq(res6.status, "failed", "the pass reports failure");
    const f6 = await DecorDraft.findById(d6._id).lean();
    eq(f6.copy.status, "failed", "copy.status = failed — a distinct third state Rohaan can filter");
    ok(/AI service error/.test(f6.copy.lastError), "…with the error recorded");
    eq(f6.status, "queued", "…while the draft is still queued and approvable");

    // ── 7. THE RETRY ENDPOINT ───────────────────────────────────────────────
    console.log("\n7. POST /decor/drafts/:id/copy");
    copyBehaviour = "ok";
    const retried = await call(decorDraft.RetryCopy, { id: String(d6._id) });
    eq(retried.status, 200, "retry returns 200");
    eq(retried.body.status, "ready", "…and reports ready");
    const r6 = await DecorDraft.findById(d6._id).lean();
    eq(r6.copy.status, "ready", "the draft recovers");
    eq(r6.copy.attempts, 2, "…attempts incremented across both runs");
    eq(r6.suggested.name, "Ivory Cascade", "…and the copy is written");

    const bad = await call(decorDraft.RetryCopy, { id: "not-an-id" });
    eq(bad.status, 400, "a malformed id is 400");
    const missing = await call(decorDraft.RetryCopy, { id: String(new mongoose.Types.ObjectId()) });
    eq(missing.status, 404, "an unknown draft is 404");
    const onApproved = await call(decorDraft.RetryCopy, { id: String(d5._id) });
    eq(onApproved.status, 409, "an already-approved draft is 409 — the copy has nowhere to go");

    // ── 8. A HUMAN'S EDIT IS NOT CLOBBERED ──────────────────────────────────
    console.log("\n8. the pass never overwrites what the approver typed");
    copyCalls = 0; scheduled = [];
    const d8 = await newDraft({ cached: true });
    await DecorDraft.updateOne({ _id: d8._id }, { $set: { "draft.name": "Typed While Waiting" } });
    await DecorDraftService.runCopyPass(d8._id, Buffer.from("x"));
    const a8 = await DecorDraft.findById(d8._id).lean();
    eq(a8.draft.name, "Typed While Waiting", "the human's draft.name survives the pass");
    eq(a8.suggested.name, "Ivory Cascade", "…while suggested.name still records what the AI said");
    eq(a8.copy.status, "ready", "…and the pass completes normally");
  } catch (e) {
    fail++; console.error("  ✗ threw:", e);
  } finally {
    copyBehaviour = "ok";
    await DecorDraft.deleteMany({ _id: { $in: drafts } });
    await Decor.deleteMany({ _id: { $in: decors.filter(Boolean) } });
    await DecorImageRead.deleteMany({ _id: { $in: reads } });
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
