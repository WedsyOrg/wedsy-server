/**
 * A2S bulk-upload intake — POST /decor/drafts/uploads and everything under it.
 *
 * Covers: Seam A (explicit occasion precedence in panelQuoteFor, undefined-
 * keyed), Seam B (the synthetic staff-category clone — aiAnalysis stays purely
 * what the AI said), the uploadQuote contract (never null on an upload draft;
 * "quoted" or a distinguishable no_quote reason: ai_rejected | no_price |
 * quote_failed), batch semantics (one batchId, sequential distinct codes,
 * per-item isolation, the 5 cap, truncation → 413), the origin-aware approve
 * stamp (source "upload" vs "extension"), the copy-pass naming context, the
 * Get detail split (non-approvers lose exactly the aiAnalysis key), and the
 * CreateUploads multipart contract.
 *
 * The AI and S3 edges are stubbed via DecorDraftService.__deps. Seam A is
 * tested through the REAL panelQuoteFor with spies wrapped around
 * decorDemoPrice's exports — installed BEFORE decorReadCache destructures
 * them, which is why the require order at the top of this file matters.
 *
 *   node tests/a2s-upload-intake.test.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

// ── Spies FIRST — decorReadCache destructures these at its own require ──────
const demo = require("../services/decorDemoPrice");
const realBuildDemoPrice = demo.buildDemoPrice;
const realResolveOccasion = demo.resolveOccasion;
let buildCalls = [];
let resolveCalls = [];
demo.buildDemoPrice = (analysis, comps, opts) => {
  const out = realBuildDemoPrice(analysis, comps, opts);
  buildCalls.push({
    occasion: opts ? opts.occasion : undefined,
    outCategory: out && out.category,
  });
  return out;
};
demo.resolveOccasion = (pinText, visionOccasion) => {
  resolveCalls.push({ pinText, visionOccasion });
  return realResolveOccasion(pinText, visionOccasion);
};

const { panelQuoteFor } = require("../services/decorReadCache");
const DecorDraftService = require("../services/DecorDraftService");
const decorDraft = require("../controllers/decorDraft");
const DecorDraft = require("../models/DecorDraft");
const Decor = require("../models/Decor");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");

const TAG = `a2sup-${Date.now()}`;
let pass = 0,
  fail = 0;
const ok = (c, label) => {
  if (c) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.error(`  ✗ ${label}`);
  }
};
const threw = async (fn) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
};
const call = (handler, req) =>
  new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) {
        this.statusCode = c;
        return this;
      },
      send(b) {
        resolve({ status: this.statusCode, body: b });
      },
    };
    handler(req, res, () => resolve({ status: res.statusCode, body: null }));
  });

// ── Stub the expensive edges (AI + S3). panelQuoteFor is a __deps entry too,
// so the service tests observe the clone without touching the real function
// Seam A is tested against. ──────────────────────────────────────────────────
const DEMO_READ = {
  isDecorProduct: true,
  category: "Photobooth", // the AI's read — deliberately NOT what staff will say
  categoryConfidence: 0.85,
  style: null,
  size: { length: 8, width: 8, confidence: 0.7 },
  complexity: { tier: "standard", confidence: 0.7, reasoning: "balanced build" },
  observations: [],
  minBuildWidth: null,
  recommendedSize: null,
  stageMeasurements: null,
  occasion: { value: "mehendi", confidence: 0.9 }, // a confident vision guess that must NOT win
};
const DEMO_READ_REJECTED = {
  isDecorProduct: false,
  category: null,
  categoryConfidence: 0,
  size: { length: 0, width: 0, confidence: 0 },
  complexity: { tier: "standard", confidence: 0.6, reasoning: "primarily a portrait of a couple" },
  occasion: { value: null, confidence: 0 },
};

let visionResult = DEMO_READ;
const quoteCalls = [];
const copyScheduled = [];
const contextCalls = [];

DecorDraftService.__deps.storeUploadedImage = async ({ buffer, path, id }) => ({
  url: `https://s3.test/${path}/${id}.jpg`,
  buffer,
});
DecorDraftService.__deps.toAnalysisBase64 = async () => "FAKEB64";
DecorDraftService.__deps.analyseForUpload = async () => JSON.parse(JSON.stringify(visionResult));
DecorDraftService.__deps.scheduleCopyPass = (draftId, buffer) =>
  copyScheduled.push({ draftId: String(draftId), hasBuffer: !!buffer });
DecorDraftService.__deps.panelQuoteFor = async (analysis, opts) => {
  quoteCalls.push({
    analysis: JSON.parse(JSON.stringify(analysis)),
    opts: JSON.parse(JSON.stringify(opts ?? null)),
  });
  const b = DecorDraftService.__deps.panelQuoteFor.behave;
  if (b === "throw") throw new Error("engine exploded");
  if (b === "null") return null;
  return {
    category: analysis.category,
    tier: "natural",
    size: "24x16",
    basis: "size-ladder",
    low: 40000,
    high: 60000,
    midpoint: 50000,
    headroomApplied: 1.15,
    floralRunPriced: false,
    tierPrices: {},
  };
};
DecorDraftService.__deps.buildListingContext = async (cat) => {
  contextCalls.push(cat);
  return { existingNames: [], attributeOptions: {} };
};
DecorDraftService.__deps.analyseForCopy = async () => ({
  suggestedName: "Upload Test Name",
  description: "d",
  tags: ["t"],
  included: [],
  category: "Stage",
  style: "Modern",
  colors: [],
  flowers: [],
  fabric: [],
});
DecorDraftService.__deps.fetchRemoteImage = async () => ({ buffer: Buffer.from("x") });

const IMG = Buffer.from(`fake-image-bytes-${TAG}`);
const file = (name, opts = {}) => ({ name, data: IMG, truncated: false, ...opts });

const batchIds = [];
const draftIds = [];
const decorIds = [];
const adminIds = [];
const roleIds = [];

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  try {
    const dept = await Department.create({ name: `${TAG}-dept` });
    const roleFounder = await Role.create({
      name: `${TAG}-founder`,
      departmentId: dept._id,
      permissions: ["*:*:all"],
    });
    const roleNo = await Role.create({
      name: `${TAG}-sales`,
      departmentId: dept._id,
      permissions: ["leads:view:own"],
    });
    roleIds.push(roleFounder._id, roleNo._id);
    const founder = await Admin.create({
      name: `${TAG}-founder`, email: `${TAG}f@x.com`, phone: `${TAG}1`,
      password: "x", status: "active", departmentId: dept._id, roleIds: [roleFounder._id],
    });
    const sales = await Admin.create({
      name: `${TAG}-sales`, email: `${TAG}s@x.com`, phone: `${TAG}2`,
      password: "x", status: "active", departmentId: dept._id, roleIds: [roleNo._id],
    });
    adminIds.push(founder._id, sales._id);

    // ── 1. Seam A — explicit occasion precedence, undefined-keyed ────────────
    // Through the REAL panelQuoteFor; the spies observe what reached the engine.
    console.log("1. Seam A: explicit occasion precedence in panelQuoteFor");
    const stageRead = () => ({
      ...JSON.parse(JSON.stringify(DEMO_READ)),
      category: "Stage",
      occasion: { value: "haldi", confidence: 0.8 },
    });

    buildCalls = []; resolveCalls = [];
    await panelQuoteFor(stageRead(), { pinText: "gorgeous haldi backdrop" });
    ok(resolveCalls.length === 1, "absent key: resolveOccasion runs (the A2S branch, unchanged)");
    ok(resolveCalls[0].pinText === "gorgeous haldi backdrop", "absent key: pinText forwarded verbatim");
    ok(buildCalls[0].occasion && buildCalls[0].occasion.value === "haldi",
      "absent key: the resolved occasion reaches the engine");
    ok(buildCalls[0].outCategory === "Haldi", "absent key: Stage relabels to Haldi (today's behaviour)");

    buildCalls = []; resolveCalls = [];
    await panelQuoteFor(stageRead(), { pinText: "gorgeous haldi backdrop", occasion: null });
    ok(resolveCalls.length === 0, "explicit null: resolveOccasion NOT called — no truthiness fallthrough");
    ok(buildCalls[0].occasion === null, "explicit null: the engine receives null");
    ok(buildCalls[0].outCategory === "Stage", "explicit null: a pinText keyword cannot resurrect the relabel");

    buildCalls = []; resolveCalls = [];
    await panelQuoteFor(stageRead(), {
      pinText: "no keywords here",
      occasion: { value: "haldi", source: "staff", conflict: null },
    });
    ok(resolveCalls.length === 0, "explicit haldi: resolveOccasion NOT called");
    ok(buildCalls[0].occasion.source === "staff", "explicit haldi: the staff object passes through untouched");
    ok(buildCalls[0].outCategory === "Haldi", "explicit haldi on Stage: the relabel fires");

    buildCalls = []; resolveCalls = [];
    const pbRead = stageRead();
    pbRead.category = "Photobooth";
    await panelQuoteFor(pbRead, { occasion: { value: "haldi", source: "staff", conflict: null } });
    ok(buildCalls[0].outCategory === "Photobooth",
      "explicit haldi on Photobooth: recorded but price-inert — only Stage flips");

    // ── 2. Seam B — the clone; aiAnalysis stays purely the AI's ──────────────
    console.log("2. upload draft: staff category + occasion honoured; aiAnalysis untouched");
    visionResult = DEMO_READ;
    quoteCalls.length = 0;
    const b1 = await DecorDraftService.createUploadBatch(
      { items: [{ buffer: IMG, originalFilename: "a.jpg", category: "Stage", occasion: "haldi" }] },
      sales._id
    );
    batchIds.push(b1.batchId);
    ok(b1.results[0].status === "queued", "item queued");
    const d1 = b1.results[0].draft;
    draftIds.push(d1._id);
    ok(quoteCalls.length === 1, "one quote call");
    ok(quoteCalls[0].analysis.category === "Stage", "the clone carries the STAFF category");
    ok(quoteCalls[0].analysis.categoryConfidence === null, "clone confidence nulled — no model judged this category");
    ok(quoteCalls[0].analysis.isDecorProduct === true, "isDecorProduct INHERITED from the read, never asserted");
    ok(quoteCalls[0].analysis.size.length === 8, "the AI's measurements survive the clone");
    ok(quoteCalls[0].opts.occasion && quoteCalls[0].opts.occasion.value === "haldi"
      && quoteCalls[0].opts.occasion.source === "staff",
      "the staff occasion is explicit — vision's mehendi guess did not win");
    ok(d1.draft.category === "Stage", "draft.category = what staff said");
    ok(d1.suggested.category === "Photobooth", "suggested.category = what the AI said");
    ok(d1.aiAnalysis.pricing.analysis.category === "Photobooth", "aiAnalysis keeps the vision category");
    ok(d1.aiAnalysis.pricing.analysis.occasion.value === "mehendi", "aiAnalysis keeps the vision occasion");
    ok(JSON.stringify(d1.aiAnalysis).indexOf('"staff"') === -1, "nothing staff-labelled inside aiAnalysis");
    ok(d1.upload.categoryDisagreement
      && d1.upload.categoryDisagreement.vision === "Photobooth"
      && d1.upload.categoryDisagreement.staff === "Stage",
      "disagreement recorded as { vision, staff } on the upload subdoc");
    ok(d1.pricing.panelQuote === null, "panelQuote stays null — no client was quoted");
    ok(d1.pricing.uploadQuote.status === "quoted" && d1.pricing.uploadQuote.midpoint === 50000,
      "uploadQuote: the quoted case carries the figure");
    ok(d1.pricing.uploadQuote.inputs.category === "Stage" && d1.pricing.uploadQuote.inputs.occasion === "haldi",
      "uploadQuote records the staff inputs");
    ok(d1.sourceRead.source === "upload", 'sourceRead.source = "upload"');
    ok(d1.copy.status === "pending", "the copy is deferred");
    ok(copyScheduled.some((c) => c.draftId === String(d1._id) && c.hasBuffer),
      "the copy pass is scheduled with the buffer in hand");

    const immut = await threw(() =>
      DecorDraft.updateOne({ _id: d1._id }, { $set: { "pricing.uploadQuote.midpoint": 1 } })
    );
    ok(immut && /immutable/.test(immut.message), "uploadQuote is immutable after create");

    // ── 3. the three no_quote reasons are distinct ───────────────────────────
    console.log("3. uploadQuote: never null on an upload draft; blanks say why");
    visionResult = DEMO_READ_REJECTED;
    quoteCalls.length = 0;
    const b2 = await DecorDraftService.createUploadBatch(
      { items: [{ buffer: IMG, category: "Stage", occasion: "haldi" }] },
      sales._id
    );
    batchIds.push(b2.batchId);
    const d2 = b2.results[0].draft;
    ok(b2.results[0].status === "queued", "an AI rejection does not veto the draft — staff asserted a product");
    ok(quoteCalls.length === 0, "…but no price is computed: the engine is never called");
    ok(d2.pricing.uploadQuote.status === "no_quote" && d2.pricing.uploadQuote.reason === "ai_rejected",
      'reason "ai_rejected"');
    ok(/portrait of a couple/.test(d2.pricing.uploadQuote.detail), "detail carries the model's own reasoning");
    ok(/did not read this as a décor product/.test(d2.history[0].note), "the history note says it too");
    ok(d2.aiAnalysis.pricing.rejected === true, "the rejection itself sits in the immutable record");

    visionResult = DEMO_READ;
    DecorDraftService.__deps.panelQuoteFor.behave = "null";
    const b3 = await DecorDraftService.createUploadBatch(
      { items: [{ buffer: IMG, category: "Furniture", occasion: "" }] },
      sales._id
    );
    batchIds.push(b3.batchId);
    ok(b3.results[0].draft.pricing.uploadQuote.reason === "no_price", 'engine null → reason "no_price"');
    ok(quoteCalls[quoteCalls.length - 1].opts.occasion === null,
      "empty occasion → EXPLICIT null to Seam A (staff's 'none' suppresses inference)");

    DecorDraftService.__deps.panelQuoteFor.behave = "throw";
    const b4 = await DecorDraftService.createUploadBatch(
      { items: [{ buffer: IMG, category: "Stage", occasion: "haldi" }] },
      sales._id
    );
    batchIds.push(b4.batchId);
    const q4 = b4.results[0].draft.pricing.uploadQuote;
    ok(q4.reason === "quote_failed" && /engine exploded/.test(q4.detail),
      'engine throw → reason "quote_failed" with the message');
    ok(b4.results[0].status === "queued", "a quote failure does not lose the draft");
    DecorDraftService.__deps.panelQuoteFor.behave = null;

    // ── PINNED (founder check, 2026-08-31): uploadQuote is TRUTHY on every
    // upload draft, so no consumer may treat it as a boolean "has a price" —
    // the branch key is `status`. The structural defence pinned here: a
    // no_quote object carries NO figure fields, so even a naive
    // `(panelQuote || uploadQuote).midpoint` reads undefined, never a wrong
    // number shown to a client.
    for (const [label, q] of [
      ["ai_rejected", d2.pricing.uploadQuote],
      ["no_price", b3.results[0].draft.pricing.uploadQuote],
      ["quote_failed", q4],
    ]) {
      ok(q && q.status === "no_quote"
        && !("midpoint" in q) && !("low" in q) && !("high" in q) && !("tierPrices" in q),
        `${label}: truthy, but NO figure fields — truthiness cannot leak a price`);
    }

    // ── 4. batch semantics ───────────────────────────────────────────────────
    console.log("4. batch: one id, sequential codes, per-item isolation, the cap");
    const b5 = await DecorDraftService.createUploadBatch(
      {
        items: [
          { buffer: IMG, category: "Stage", occasion: "haldi" },
          { buffer: IMG, category: "NotACategory", occasion: "haldi" },
          { buffer: IMG, category: "Stage", occasion: "" },
        ],
      },
      sales._id
    );
    batchIds.push(b5.batchId);
    ok(b5.results.map((r) => r.position).join(",") === "0,1,2", "positions 0,1,2");
    ok(b5.results[0].status === "queued" && b5.results[2].status === "queued", "good items queued");
    ok(b5.results[1].status === "failed" && b5.results[1].httpStatus === 400
      && /Unknown décor category/.test(b5.results[1].error),
      "a bad category fails ALONE, 400-shaped");
    ok(String(b5.results[0].draft.upload.batchId) === b5.batchId
      && String(b5.results[2].draft.upload.batchId) === b5.batchId,
      "one batchId shared across the batch");
    const c0 = b5.results[0].draft.draft.productCode;
    const c2 = b5.results[2].draft.draft.productCode;
    ok(c0 && c2 && c0 !== c2, `sequential creation → distinct provisional codes (${c0}, ${c2})`);

    let e = await threw(() =>
      DecorDraftService.createUploadBatch(
        { items: Array(6).fill({ buffer: IMG, category: "Stage", occasion: "" }) },
        sales._id
      )
    );
    ok(e && e.status === 400 && /at most 5/.test(e.message), "6 items → 400");
    e = await threw(() => DecorDraftService.createUploadBatch({ items: [] }, sales._id));
    ok(e && e.status === 400, "empty batch → 400");
    const occBad = await DecorDraftService.createUploadBatch(
      { items: [{ buffer: IMG, category: "Stage", occasion: "diwali" }] },
      sales._id
    );
    batchIds.push(occBad.batchId);
    ok(occBad.results[0].status === "failed" && /Unknown occasion/.test(occBad.results[0].error),
      "an unknown occasion fails the item, not the batch");

    // ── 5. approve stamps source by origin ───────────────────────────────────
    console.log("5. approve: source 'upload' vs 'extension'");
    await DecorDraft.updateOne({ _id: d1._id }, { $set: { "draft.name": `${TAG} Upload Stage` } });
    const ap1 = await DecorDraftService.approveDraft(
      String(d1._id),
      {
        category: "Stage",
        name: `${TAG} Upload Stage`,
        productTypes: [{ name: "Natural Flowers", sellingPrice: 50000, costPrice: 0, discount: 0 }],
      },
      founder._id
    );
    decorIds.push(ap1.decorId);
    const pub1 = await Decor.findById(ap1.decorId).lean();
    ok(pub1.source === "upload", `an upload draft publishes source "upload" (got "${pub1.source}")`);

    const extDraft = await DecorDraft.create({
      sourceImage: { url: `https://i.pinimg.com/564x/aa/bb/${TAG}.jpg`, normalizedUrl: `pinimg/aa/bb/${TAG}.jpg` },
      storedImage: "https://s3.test/decor-drafts/ext.jpg",
      draft: { category: "Stage", name: `${TAG} Ext Stage`, productCode: "" },
      status: "queued",
    });
    draftIds.push(extDraft._id);
    const ap2 = await DecorDraftService.approveDraft(
      String(extDraft._id),
      {
        category: "Stage",
        name: `${TAG} Ext Stage`,
        productTypes: [{ name: "Natural Flowers", sellingPrice: 40000, costPrice: 0, discount: 0 }],
      },
      founder._id
    );
    decorIds.push(ap2.decorId);
    const pub2 = await Decor.findById(ap2.decorId).lean();
    ok(pub2.source === "extension", `an extension draft still publishes source "extension" (got "${pub2.source}")`);

    // ── 6. the copy pass scopes its naming context by origin ─────────────────
    console.log("6. copy-pass naming context");
    contextCalls.length = 0;
    const d3 = b5.results[2].draft; // upload: staff Stage over a Photobooth read
    await DecorDraftService.runCopyPass(d3._id, { buffer: IMG });
    ok(contextCalls[0] === "Stage", `upload draft: context = STAFF category (got "${contextCalls[0]}")`);

    const extPending = await DecorDraft.create({
      sourceImage: { url: `https://i.pinimg.com/564x/cc/dd/${TAG}.jpg`, normalizedUrl: `pinimg/cc/dd/${TAG}.jpg` },
      storedImage: "https://s3.test/decor-drafts/ext2.jpg",
      aiAnalysis: { listing: null, pricing: { analysis: { category: "Photobooth" } } },
      // A human edit on the working copy that must NOT leak into extension context:
      draft: { category: "Stage" },
      status: "queued",
      copy: { status: "pending", attempts: 0 },
    });
    draftIds.push(extPending._id);
    contextCalls.length = 0;
    await DecorDraftService.runCopyPass(extPending._id, { buffer: IMG });
    ok(contextCalls[0] === "Photobooth", `extension draft: context = VISION category (got "${contextCalls[0]}")`);

    // ── 7. Get: non-approvers lose exactly the aiAnalysis key ────────────────
    console.log("7. Get detail split");
    const detailId = String(b5.results[2].draft._id);
    const asFounder = await call(decorDraft.Get, { auth: { user_id: founder._id }, params: { id: detailId } });
    const asSales = await call(decorDraft.Get, { auth: { user_id: sales._id }, params: { id: detailId } });
    ok(asFounder.status === 200 && asFounder.body.aiAnalysis && asFounder.body.aiAnalysis.pricing,
      "an approver receives the full aiAnalysis");
    ok(asSales.status === 200, "a non-approver is answered, not refused");
    ok(!("aiAnalysis" in asSales.body), "…their document has NO aiAnalysis key");
    ok(asSales.body.pricing && asSales.body.pricing.uploadQuote,
      "…and still sees uploadQuote — the sales-facing price");
    const fKeys = Object.keys(asFounder.body).filter((k) => k !== "aiAnalysis").sort();
    ok(JSON.stringify(fKeys) === JSON.stringify(Object.keys(asSales.body).sort()),
      "the two documents differ by exactly the aiAnalysis key");
    ok(JSON.stringify(asFounder.body.pricing) === JSON.stringify(asSales.body.pricing),
      "pricing is byte-identical for both viewers");

    // ── 8. CreateUploads — the multipart contract ────────────────────────────
    console.log("8. CreateUploads route contract");
    let r = await call(decorDraft.CreateUploads, {
      auth: { user_id: sales._id },
      files: { image_0: file("a.jpg"), image_1: file("b.png") },
      body: { category_0: "Stage", occasion_0: "haldi", category_1: "Photobooth", occasion_1: "" },
    });
    ok(r.status === 201 && r.body.batchId && r.body.results.length === 2, "201 with batchId + 2 results");
    batchIds.push(r.body.batchId);
    ok(r.body.results.every((x) => x.status === "queued")
      && r.body.results.map((x) => x.position).join(",") === "0,1",
      "both queued; position equals the field index");
    ok(String(r.body.results[0].draft.addedBy) === String(sales._id), "addedBy = the uploader");

    r = await call(decorDraft.CreateUploads, {
      auth: { user_id: sales._id },
      files: { image_0: file("a.jpg"), image_2: file("c.jpg") }, // gap at 1
      body: { category_0: "Stage", occasion_0: "" },
    });
    ok(r.status === 400 && /contiguous/.test(r.body.message), "a gap in the indices → 400");
    r = await call(decorDraft.CreateUploads, {
      auth: { user_id: sales._id },
      files: { photo_0: file("a.jpg") },
      body: {},
    });
    ok(r.status === 400, "a stray field name → 400, not a silent drop");
    r = await call(decorDraft.CreateUploads, { auth: { user_id: sales._id }, files: {}, body: {} });
    ok(r.status === 400, "no files → 400");

    r = await call(decorDraft.CreateUploads, {
      auth: { user_id: sales._id },
      files: { image_0: file("big.jpg", { truncated: true }), image_1: file("ok.jpg") },
      body: { category_0: "Stage", occasion_0: "", category_1: "Stage", occasion_1: "haldi" },
    });
    ok(r.status === 201, "one good item → still 201");
    batchIds.push(r.body.batchId);
    ok(r.body.results[0].status === "failed" && r.body.results[0].httpStatus === 413
      && /cut off/.test(r.body.results[0].error),
      "a truncated file → per-item 413 (express-fileupload cuts, it does not reject)");
    ok(r.body.results[1].status === "queued", "…the other item queued");

    r = await call(decorDraft.CreateUploads, {
      auth: { user_id: sales._id },
      files: { image_0: file("a.jpg") },
      body: { category_0: "NotACategory", occasion_0: "" },
    });
    ok(r.status === 400 && r.body.message === "no drafts created", "every item failed → 400");
    batchIds.push(r.body.batchId);
  } catch (err) {
    fail++;
    console.error("UNEXPECTED", err);
  } finally {
    // ── cleanup — tagged data only ──
    try {
      await DecorDraft.deleteMany({
        "upload.batchId": { $in: batchIds.filter(Boolean).map((x) => new mongoose.Types.ObjectId(x)) },
      });
      await DecorDraft.deleteMany({ _id: { $in: draftIds } });
      await Decor.deleteMany({ _id: { $in: decorIds } });
      await Admin.deleteMany({ _id: { $in: adminIds } });
      await Role.deleteMany({ _id: { $in: roleIds } });
      await Department.deleteMany({ name: `${TAG}-dept` });
    } catch (e) {
      console.error("cleanup failed", e && e.message);
    }
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
