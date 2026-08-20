/**
 * createdBy — who put the product in the catalogue (2026-08-20).
 *
 * Same meaning on both creation paths: POST /decor records the authenticated
 * admin, A2S approve records the APPROVER. Products predating this stay null and
 * display "Unknown" — permanently, by design.
 *
 * AI edges stubbed via DecorDraftService.__deps — no Anthropic, no S3.
 *
 *   node tests/decor-createdby.test.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Decor = require("../models/Decor");
const DecorDraft = require("../models/DecorDraft");
const Admin = require("../models/Admin");
const Department = require("../models/Department");
const DecorDraftService = require("../services/DecorDraftService");
const decor = require("../controllers/decor");

const TAG = `cby-${Date.now()}`;
const CAT = "Stage";
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${JSON.stringify(got)} vs ${JSON.stringify(want)})`);

const call = (handler, { params = {}, query = {}, body = {}, auth } = {}) =>
  new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      send(b) { resolve({ status: this.statusCode, body: b }); },
      json(b) { resolve({ status: this.statusCode, body: b }); },
    };
    Promise.resolve(handler({ params, query, body, auth }, res)).catch((e) => resolve({ status: 500, body: { message: e.message } }));
  });

const COPY = { suggestedName: "Ivory Cascade", description: "d", tags: [], included: [], category: CAT, style: "Modern", colors: [], flowers: [], fabric: [] };
DecorDraftService.__deps.storeRemoteImage = async ({ id }) => ({ url: `https://s3.test/${id}.jpg`, buffer: Buffer.from("x") });
DecorDraftService.__deps.toAnalysisBase64 = async () => "B64";
DecorDraftService.__deps.buildListingContext = async () => ({ existingNames: [], attributeOptions: {}, scopedTo: null });
DecorDraftService.__deps.analyseForCopy = async () => JSON.parse(JSON.stringify(COPY));
DecorDraftService.__deps.runPricingBrain = async () => ({
  analysis: { isDecorProduct: true, category: CAT, categoryConfidence: 0.9, style: "Modern",
    size: { length: 24, width: 16, confidence: 0.8 },
    complexity: { tier: "standard", confidence: 0.7, reasoning: "r" }, ...COPY },
  pricing: { category: CAT, applicableTiers: ["artificial"], suggested: { artificial: 60000 } },
  fallbacks: [], rejected: false,
});

const decors = [], drafts = [], admins = [], depts = [];
(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  try {
    const dept = await Department.create({ name: `${TAG}-dept` }); depts.push(dept._id);
    const varsha = await Admin.create({ name: `${TAG} Varsha`, email: `${TAG}v@x.com`, phone: `${TAG}1`, password: "x", status: "active", departmentId: dept._id });
    const rohaan = await Admin.create({ name: `${TAG} Rohaan`, email: `${TAG}r@x.com`, phone: `${TAG}2`, password: "x", status: "active", departmentId: dept._id });
    admins.push(varsha._id, rohaan._id);

    // ── 1. POST /decor ──────────────────────────────────────────────────────
    console.log("1. POST /decor records the authenticated admin");
    const made = await call(decor.CreateNew, {
      auth: { user_id: rohaan._id },
      body: { category: CAT, name: `${TAG} manual`, unit: "Pc", image: "https://s3.test/a.jpg", thumbnail: "https://s3.test/a.jpg", productInfo: { id: `${TAG}m1` } },
    });
    eq(made.status, 201, "created");
    decors.push(made.body.id);
    const manual = await Decor.findById(made.body.id).lean();
    eq(String(manual.createdBy), String(rohaan._id), "createdBy = the authenticated admin");
    eq(manual.source, "", "…and source stays unset for a manual product");

    // it must come from auth, NOT the body
    const spoof = await call(decor.CreateNew, {
      auth: { user_id: rohaan._id },
      body: { category: CAT, name: `${TAG} spoof`, unit: "Pc", image: "https://s3.test/a.jpg", thumbnail: "https://s3.test/a.jpg", productInfo: { id: `${TAG}m2` }, createdBy: String(varsha._id) },
    });
    decors.push(spoof.body.id);
    const spoofed = await Decor.findById(spoof.body.id).lean();
    eq(String(spoofed.createdBy), String(rohaan._id), "a createdBy in the BODY is ignored — it comes from the token");

    // ── 2. A2S approve ──────────────────────────────────────────────────────
    console.log("\n2. A2S approve records the APPROVER, not the A2S adder");
    const d = await DecorDraftService.createDraft(
      { imageUrl: `https://i.pinimg.com/564x/ab/cd/${TAG}1.jpg`, pinId: `${TAG}-1`, pinText: "stage" },
      varsha._id // Varsha clicked A2S
    );
    drafts.push(d._id);
    const r = await DecorDraftService.approveDraft(d._id, {
      category: CAT, name: "Ivory Cascade", productCode: `${TAG}e1`,
      productTypes: [{ name: "Artificial Flowers", sellingPrice: 60000 }],
    }, rohaan._id); // Rohaan approved
    decors.push(r.decorId);
    const pub = await Decor.findById(r.decorId).lean();
    eq(String(pub.createdBy), String(rohaan._id), "createdBy = the approver (Rohaan)");
    ok(String(pub.createdBy) !== String(varsha._id), "…NOT the person who clicked A2S (Varsha)");
    eq(pub.source, "extension", "…and source marks it extension-added");

    // ── 3. BOTH PEOPLE STILL VISIBLE (item 6 — confirm it still holds) ──────
    console.log("\n3. the analysis tab still shows both people and both times");
    const an = await call(decor.DecorAnalysis, { params: { _id: String(r.decorId) } });
    eq(an.status, 200, "analysis returns");
    eq(an.body.addedBy.name, `${TAG} Varsha`, "addedBy = who clicked A2S");
    ok(!!an.body.addedAt, "…with when they added it");
    eq(an.body.decision.approvedBy.name, `${TAG} Rohaan`, "approvedBy = who published");
    ok(!!an.body.decision.approvedAt, "…with when they approved");
    ok(new Date(an.body.decision.approvedAt) >= new Date(an.body.addedAt), "…and the two are independently recorded");

    // ── 4. POPULATED ON THE DETAILS READ ────────────────────────────────────
    console.log("\n4. the name is available to the frontend");
    const got = await call(decor.Get, { params: { _id: String(r.decorId) }, query: {} });
    eq(got.status, 200, "GET /decor/:_id returns");
    eq(got.body.createdBy && got.body.createdBy.name, `${TAG} Rohaan`, "createdBy is POPULATED to a name");
    ok(!got.body.createdBy.password && !got.body.createdBy.email, "…and only the name — no admin record leaked");

    // ── 5. THE FILTER ───────────────────────────────────────────────────────
    console.log("\n5. GET /decor?createdBy=<adminId>");
    const mine = await call(decor.GetAll, { query: { createdBy: String(rohaan._id), limit: "200" } });
    eq(mine.status, 200, "the filter is accepted");
    const ids = (mine.body.list || []).map((x) => String(x._id));
    ok(ids.includes(String(r.decorId)) && ids.includes(String(manual._id)), "…returns BOTH creation paths — one meaning, one filter");
    ok((mine.body.list || []).every((x) => String(x.createdBy) === String(rohaan._id)), "…every row is theirs");

    const hers = await call(decor.GetAll, { query: { createdBy: String(varsha._id), limit: "200" } });
    eq((hers.body.list || []).length, 0, "the A2S adder does NOT own the product — Varsha's filter is empty");

    // ── 6. THE ~800 LEGACY PRODUCTS ─────────────────────────────────────────
    console.log("\n6. products predating this stay Unknown, permanently");
    const legacy = await Decor.create({ category: CAT, name: `${TAG} legacy`, unit: "Pc", image: "https://s3.test/l.jpg", thumbnail: "https://s3.test/l.jpg", productInfo: { id: `${TAG}L1` } });
    decors.push(legacy._id);
    eq(legacy.createdBy, null, "a product created without an actor has createdBy null");
    const legacyGot = await call(decor.Get, { params: { _id: String(legacy._id) }, query: {} });
    eq(legacyGot.body.createdBy, null, "…and reads back null, so the UI can show \"Unknown\"");
    const filteredOut = await call(decor.GetAll, { query: { createdBy: String(rohaan._id), limit: "200" } });
    ok(!(filteredOut.body.list || []).map((x) => String(x._id)).includes(String(legacy._id)),
      "…and is excluded by a creator filter — correct, but it means the filter hides legacy products");
  } catch (e) {
    fail++; console.error("  ✗ threw:", e);
  } finally {
    await Decor.deleteMany({ _id: { $in: decors.filter(Boolean) } });
    await DecorDraft.deleteMany({ _id: { $in: drafts } });
    await Admin.deleteMany({ _id: { $in: admins } });
    await Department.deleteMany({ _id: { $in: depts } });
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
