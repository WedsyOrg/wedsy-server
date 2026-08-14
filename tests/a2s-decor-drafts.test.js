/**
 * A2S ("Add to Store") — the décor approval queue.
 *
 * Covers: three-state dedupe, aiAnalysis immutability (THE non-negotiable),
 * the override-reason rule, approve→publish, product-code collisions, the
 * numeric (not lexicographic) code generator, and the store:approve:all gate.
 *
 * The two AI brains and the S3 upload are stubbed via DecorDraftService.__deps,
 * so this test never calls Anthropic or AWS.
 *
 *   node tests/a2s-decor-drafts.test.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

const DecorDraft = require("../models/DecorDraft");
const Decor = require("../models/Decor");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");
const DecorDraftService = require("../services/DecorDraftService");
const decorDraft = require("../controllers/decorDraft");
const decor = require("../controllers/decor");
const { requirePermission, permissionSatisfies, permissionsForAdmin } = require("../middlewares/requirePermission");
const { validatePermissions } = require("../utils/rbacPermissions");
const { suggestProductCode } = require("../utils/decorCode");

const TAG = `a2s-${Date.now()}`;
const CAT = `${TAG}-cat`;
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

// Run an express middleware chain to completion.
const runChain = (handlers, req) =>
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
      json(b) {
        resolve({ status: this.statusCode, body: b });
      },
    };
    let i = 0;
    const next = () => {
      const h = handlers[i++];
      if (!h) return resolve({ status: res.statusCode, body: null });
      Promise.resolve(h(req, res, next)).catch((e) => resolve({ status: 500, body: { message: e.message } }));
    };
    next();
  });

// ── Stub the expensive edges ────────────────────────────────────────────────
const FAKE_LISTING = {
  name: "Ivory Cascade",
  description: "A luxury test backdrop.",
  tags: ["floral", "ivory"],
  included: ["Decor as shown in image"],
  category: CAT,
  style: ["modern"],
  colors: ["ivory"],
  flowers: ["rose"],
  occasions: ["wedding"],
  seoKeywords: ["ivory backdrop"],
};
const FAKE_PRICING = {
  analysis: {
    isDecorProduct: true,
    category: CAT,
    categoryConfidence: 0.9,
    style: null,
    size: { length: 12, width: 8, confidence: 0.8 },
    complexity: { tier: "standard", confidence: 0.7, reasoning: "balanced" },
  },
  pricing: {
    category: CAT,
    applicableTiers: ["flat"],
    observedBand: { min: 10000, p25: 20000, median: 30000, p75: 40000, max: 90000, n: 12 },
    suggested: { flat: 30000 },
    upliftApplied: 1.1,
    comparables: [{ id: "st001", name: "Ref", flat: 29000, size: "12x8" }],
  },
  fallbacks: [],
  rejected: false,
};

DecorDraftService.__deps.storeRemoteImage = async ({ id }) => ({
  url: `https://s3.test/decor-drafts/${id}.jpg`,
  buffer: Buffer.from("fake-jpeg"),
});
DecorDraftService.__deps.toAnalysisBase64 = async () => "FAKEBASE64";
DecorDraftService.__deps.runPricingBrain = async () => JSON.parse(JSON.stringify(FAKE_PRICING));
DecorDraftService.__deps.analyseListing = async () => JSON.parse(JSON.stringify(FAKE_LISTING));

const PIN = (n) => `${TAG}-pin-${n}`;
const IMG = (n) => `https://i.pinimg.com/564x/ab/cd/${TAG}${n}.jpg`;

const draftIds = [];
const decorIds = [];
const adminIds = [];
const roleIds = [];
let dept, approver, staff, noPermAdmin, founder;
let createdIndex = false;

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  try {
    dept = await Department.create({ name: `${TAG}-dept` });
    const roleYes = await Role.create({
      name: `${TAG}-approver`,
      departmentId: dept._id,
      permissions: ["store:approve:all"],
    });
    const roleNo = await Role.create({
      name: `${TAG}-noperm`,
      departmentId: dept._id,
      permissions: ["leads:view:own"],
    });
    // A founder-shaped role: the wildcard the REAL Founder role carries.
    const roleFounder = await Role.create({
      name: `${TAG}-founder`,
      departmentId: dept._id,
      permissions: ["*:*:all"],
      systemKey: "founder",
    });
    roleIds.push(roleYes._id, roleNo._id, roleFounder._id);

    approver = await Admin.create({
      name: `${TAG}-approver`, email: `${TAG}app@x.com`, phone: `${TAG}1`,
      password: "x", status: "active", departmentId: dept._id, roleIds: [roleYes._id],
    });
    staff = await Admin.create({
      name: `${TAG}-staff`, email: `${TAG}stf@x.com`, phone: `${TAG}2`,
      password: "x", status: "active", departmentId: dept._id, roleIds: [roleNo._id],
    });
    noPermAdmin = staff;
    founder = await Admin.create({
      name: `${TAG}-founder`, email: `${TAG}fnd@x.com`, phone: `${TAG}3`,
      password: "x", status: "active", departmentId: dept._id, roleIds: [roleFounder._id],
    });
    adminIds.push(approver._id, staff._id, founder._id);

    // ── 0. the permission vocabulary accepts the new string ─────────────────
    console.log("0. capability vocabulary");
    ok(validatePermissions(["store:approve:all"]).valid, "store:approve:all validates");
    ok(!validatePermissions(["store:publish:all"]).valid, "no bogus publish verb was added");
    ok(!validatePermissions(["leads:publish:all"]).valid, "publish is not expressible on other resources");

    // ── 1. create a draft ───────────────────────────────────────────────────
    console.log("1. A2S click creates a queued draft");
    const d1 = await DecorDraftService.createDraft(
      { imageUrl: IMG(1), pinId: PIN(1), pinText: "pretty stage" },
      staff._id
    );
    draftIds.push(d1._id);
    ok(d1.status === "queued", "status is queued");
    ok(String(d1.addedBy) === String(staff._id), "addedBy is the staff member who clicked");
    ok(/^https:\/\/s3\.test\//.test(d1.storedImage), "storedImage is OUR asset, not the pinimg URL");
    ok(!!d1.aiAnalysis.listing && !!d1.aiAnalysis.pricing, "BOTH brains stored as distinct sub-objects");
    ok(d1.aiAnalysis.pricing.pricing.observedBand.n === 12, "pricing stored UNTRIMMED (observedBand survives)");
    ok(!!d1.aiAnalysis.pricing.pricing.comparables, "untrimmed: comparables survive");
    ok(d1.aiAnalysis.pricing.analysis.complexity.reasoning === "balanced", "untrimmed: complexity.reasoning survives");
    ok(d1.pricing.aiSuggested.suggested.flat === 30000, "pricing.aiSuggested captured");
    ok(d1.history.length === 1 && d1.history[0].action === "queued", "history seeded");

    // ── 2. dedupe: already QUEUED ───────────────────────────────────────────
    console.log("2. dedupe — already queued");
    const e2 = await threw(() => DecorDraftService.createDraft({ imageUrl: IMG(1), pinId: PIN(1) }, staff._id));
    ok(e2 && e2.status === 409, "repeat A2S of a queued pin is 409");
    ok(e2 && e2.code === "ALREADY_QUEUED", "code ALREADY_QUEUED");
    ok(e2 && /already queued by .+ on /.test(e2.message), `actionable message: "${e2 && e2.message}"`);
    ok((await DecorDraft.countDocuments({ "sourceImage.pinId": PIN(1) })) === 1, "no duplicate draft created");

    // dedupe also matches on the normalised URL when no pinId (size variant)
    const d2 = await DecorDraftService.createDraft({ imageUrl: IMG(2) }, staff._id);
    draftIds.push(d2._id);
    const e2b = await threw(() =>
      DecorDraftService.createDraft({ imageUrl: IMG(2).replace("/564x/", "/originals/") }, staff._id)
    );
    ok(e2b && e2b.status === 409, "a different Pinterest SIZE of the same image still dedupes");

    // ── 3. override reason rule ─────────────────────────────────────────────
    console.log("3. the override-reason rule (the training loop)");
    const e3 = await threw(() =>
      DecorDraftService.approveDraft(d1._id, { finalPrice: 45000, overridden: true, productCode: `${TAG}x1` }, approver._id)
    );
    ok(e3 && e3.status === 400, "overridden:true with no reason is rejected");
    ok(e3 && /reason is required/i.test(e3.message), "message names the reason requirement");
    ok((await DecorDraft.findById(d1._id)).status === "queued", "the draft stays queued after the rejection");

    // ── 4. approve with overridden:false (no reason needed) ─────────────────
    console.log("4. approve — accepting the AI price needs no reason");
    const CODE_A = `${TAG.slice(0, 6)}a001`;
    const r4 = await DecorDraftService.approveDraft(
      d2._id,
      { category: CAT, productCode: CODE_A, name: "Ivory Cascade", finalPrice: 30000, overridden: false },
      approver._id
    );
    decorIds.push(r4.decorId);
    ok(!!r4.decorId, "approve with overridden:false succeeds without a reason");
    ok(r4.draft.pricing.overridden === false, "overridden recorded false (the positive signal)");
    ok(r4.draft.pricing.finalPrice === 30000, "finalPrice recorded");
    ok(String(r4.draft.pricing.decidedBy) === String(approver._id), "decidedBy stamped");
    ok(!!r4.draft.pricing.decidedAt, "decidedAt stamped");

    // ── 5. approve creates a real Decor + stamps publishedDecorId ───────────
    console.log("5. approve publishes a real product");
    const published = await Decor.findById(r4.decorId).lean();
    ok(!!published, "a real Decor document exists");
    ok(published.productInfo.id === CODE_A, "productInfo.id carries the approved code");
    ok(published.image === d2.storedImage, "the product uses OUR stored image");
    ok(published.productTypes[0].sellingPrice === 30000, "the human's finalPrice is the published price");
    ok(published.productVisibility === false, "published switched OFF (curation is a separate act)");
    const reload5 = await DecorDraft.findById(d2._id).lean();
    ok(String(reload5.publishedDecorId) === String(r4.decorId), "publishedDecorId stamped on the draft");
    ok(reload5.status === "approved", "draft status approved");

    // ── 6. dedupe: already IN STORE ─────────────────────────────────────────
    console.log("6. dedupe — already in the store");
    const e6 = await threw(() => DecorDraftService.createDraft({ imageUrl: IMG(2) }, staff._id));
    ok(e6 && e6.status === 409, "re-adding a published pin is 409");
    ok(e6 && e6.code === "ALREADY_IN_STORE", "code ALREADY_IN_STORE");
    ok(e6 && e6.message === `already in the store as ${CODE_A}`, `message names the code: "${e6 && e6.message}"`);

    // ── 7. product-code collision ───────────────────────────────────────────
    console.log("7. product-code collision");
    const d7 = await DecorDraftService.createDraft({ imageUrl: IMG(7), pinId: PIN(7) }, staff._id);
    draftIds.push(d7._id);
    const e7 = await threw(() =>
      DecorDraftService.approveDraft(
        d7._id,
        { category: CAT, productCode: CODE_A, name: "Clash", finalPrice: 1000, overridden: false },
        approver._id
      )
    );
    ok(e7 && e7.status === 409, "re-using a live product code is 409 at approve time");
    ok(e7 && e7.code === "DUPLICATE_PRODUCT_CODE", "code DUPLICATE_PRODUCT_CODE");
    ok((await DecorDraft.findById(d7._id)).status === "queued", "the draft is untouched after the collision");

    // ── 8. IMMUTABILITY — the non-negotiable ────────────────────────────────
    console.log("8. aiAnalysis / pricing.aiSuggested are immutable");
    const eU1 = await threw(() =>
      DecorDraft.updateOne({ _id: d1._id }, { $set: { "aiAnalysis.listing.name": "hacked" } })
    );
    ok(eU1 && /immutable/i.test(eU1.message), "updateOne on a nested aiAnalysis path throws");

    const eU2 = await threw(() => DecorDraft.findByIdAndUpdate(d1._id, { $set: { aiAnalysis: {} } }));
    ok(eU2 && /immutable/i.test(eU2.message), "findByIdAndUpdate replacing aiAnalysis throws");

    const eU3 = await threw(() =>
      DecorDraft.updateOne({ _id: d1._id }, { $set: { "pricing.aiSuggested": { flat: 1 } } })
    );
    ok(eU3 && /immutable/i.test(eU3.message), "updateOne on pricing.aiSuggested throws");

    const eU4 = await threw(() => DecorDraft.updateMany({}, { $unset: { aiAnalysis: "" } }));
    ok(eU4 && /immutable/i.test(eU4.message), "a bulk $unset across the collection throws");

    const eU5 = await threw(async () => {
      const doc = await DecorDraft.findById(d1._id);
      doc.aiAnalysis = { wiped: true };
      doc.markModified("aiAnalysis");
      await doc.save();
    });
    ok(eU5 && /immutable/i.test(eU5.message), "doc.save() after mutating aiAnalysis throws");

    const stillThere = await DecorDraft.findById(d1._id).lean();
    ok(
      stillThere.aiAnalysis.pricing.pricing.observedBand.n === 12 &&
        stillThere.aiAnalysis.listing.name === "Ivory Cascade",
      "after every attempt the original analysis is intact",
    );
    ok(stillThere.pricing.aiSuggested.suggested.flat === 30000, "pricing.aiSuggested intact");

    // a NORMAL update still works (immutability is targeted, not blanket)
    await DecorDraft.updateOne({ _id: d1._id }, { $set: { "draft.name": "Renamed" } });
    ok((await DecorDraft.findById(d1._id)).draft.name === "Renamed", "ordinary draft edits still work");

    // ── 9. reject → kept, and re-add needs force ────────────────────────────
    console.log("9. reject keeps the draft; re-add needs force");
    const rej = await DecorDraftService.rejectDraft(d7._id, { reason: "off-brand" }, approver._id);
    ok(rej.status === "rejected", "status rejected");
    ok(rej.rejection.reason === "off-brand", "rejection reason kept");
    ok(!!(await DecorDraft.findById(d7._id)), "rejected draft is KEPT, not deleted");
    ok((await Decor.countDocuments({ name: "Clash" })) === 0, "nothing published on reject");

    const e9 = await threw(() => DecorDraftService.createDraft({ imageUrl: IMG(7), pinId: PIN(7) }, staff._id));
    ok(e9 && e9.status === 409 && e9.code === "PREVIOUSLY_REJECTED", "re-adding a rejected pin returns the override affordance");
    ok(e9 && e9.canForce === true, "canForce:true is advertised");
    ok(e9 && /add anyway\?/.test(e9.message), `message offers the override: "${e9 && e9.message}"`);

    const forced = await DecorDraftService.createDraft(
      { imageUrl: IMG(7), pinId: PIN(7), force: true },
      staff._id
    );
    draftIds.push(forced._id);
    ok(forced.status === "queued", "force:true creates a fresh draft");
    ok(String(forced.supersedesDraftId) === String(d7._id), "the retry links to what was declined");
    ok((await DecorDraft.countDocuments({ "sourceImage.pinId": PIN(7) })) === 2, "the rejected draft still exists alongside");

    // ── 10. the store:approve:all gate ──────────────────────────────────────
    console.log("10. store:approve:all gates approve/reject");
    const gate = requirePermission("store:approve:all");
    const denied = await runChain([gate, decorDraft.Approve], {
      params: { id: String(forced._id) },
      body: { category: CAT, productCode: `${TAG.slice(0, 6)}z9`, name: "X", finalPrice: 1, overridden: false },
      auth: { user_id: String(noPermAdmin._id) },
      query: {},
    });
    ok(denied.status === 403, "an admin without store:approve:all gets 403 on approve");
    ok(denied.body && denied.body.required === "store:approve:all", "403 names the required permission");
    ok((await DecorDraft.findById(forced._id)).status === "queued", "the draft was not approved");

    const allowed = await runChain([gate, decorDraft.Approve], {
      params: { id: String(forced._id) },
      body: { category: CAT, productCode: `${TAG.slice(0, 6)}b002`, name: "Allowed", finalPrice: 5000, overridden: true, reason: "premium build" },
      auth: { user_id: String(approver._id) },
      query: {},
    });
    ok(allowed.status === 201, "an admin WITH the permission approves");
    if (allowed.body && allowed.body.decorId) decorIds.push(allowed.body.decorId);
    ok(allowed.body && allowed.body.draft.pricing.reason === "premium build", "the override reason is persisted");

    // ── 11. the code generator ──────────────────────────────────────────────
    console.log("11. product-code generator");
    const GEN_CAT = `${TAG}-gen`;
    const fixture = (name, id) => ({
      category: GEN_CAT, name, unit: "Pc",
      image: "https://s3.test/x.jpg", thumbnail: "https://s3.test/x.jpg",
      productInfo: { id },
    });
    const seeded = await Decor.create([fixture("g1", "zz099"), fixture("g2", "zz100")]);
    seeded.forEach((s) => decorIds.push(s._id));
    const next = await suggestProductCode(GEN_CAT);
    ok(next === "zz101", `numeric max, not lexicographic — got "${next}" (legacy sort would say zz100)`);
    ok(/^[a-z]+\d{3}$/.test(next), "3-digit zero-padded lowercase");

    // ── 12. the Decor unique index actually bites ───────────────────────────
    // The index is NOT declared on the schema (no autoIndex-at-boot) — it is
    // created by scripts/migrate-decor-productid-unique-index.js. We create it
    // here with the SAME spec if it's missing, and drop it again in cleanup
    // only if this test was the one that created it.
    console.log("12. duplicate guard on productInfo.id");
    const decorCol = mongoose.connection.db.collection("decors");
    const hadIndex = (await decorCol.indexes()).some((i) => i.name === "productInfo_id_unique");
    if (!hadIndex) {
      await decorCol.createIndex(
        { "productInfo.id": 1 },
        {
          unique: true,
          partialFilterExpression: { "productInfo.id": { $type: "string", $gt: "" } },
          name: "productInfo_id_unique",
        }
      );
      createdIndex = true;
    }
    ok(
      (await decorCol.indexes()).some((i) => i.name === "productInfo_id_unique"),
      "productInfo_id_unique is present"
    );
    const eDup = await threw(() => Decor.create(fixture("dup", "zz099")));
    ok(eDup && eDup.code === 11000, "a duplicate productInfo.id is rejected by the unique index");
    const blank1 = await Decor.create(fixture("b1", ""));
    const blank2 = await Decor.create(fixture("b2", ""));
    decorIds.push(blank1._id, blank2._id);
    ok(!!blank2, "the index is PARTIAL — two blank codes do not collide");

    // ── 13. THE FOUNDER MUST NOT BE LOCKED OUT ──────────────────────────────
    // Gating the décor routes on store:approve:all is only safe if "*:*:all"
    // actually satisfies it. Asserted through the REAL requirePermission path,
    // not assumed.
    console.log("13. founder *:*:all satisfies store:approve:all");
    ok(
      permissionSatisfies(["*:*:all"], "store:approve:all").allowed === true,
      "permissionSatisfies: *:*:all covers store:approve:all",
    );
    ok(
      permissionSatisfies(["*:*:all"], "store:approve:all").effectiveScope === "all",
      "…with effectiveScope 'all'",
    );

    const founderPerms = await permissionsForAdmin(await Admin.findById(founder._id).lean());
    ok(founderPerms.includes("*:*:all"), "founder admin resolves to the wildcard permission");

    const founderApprove = await runChain([gate, decorDraft.Approve], {
      params: { id: String(d7._id) },
      body: { category: CAT, productCode: `${TAG.slice(0, 6)}f003`, name: "Founder Made", finalPrice: 7000, overridden: false },
      auth: { user_id: String(founder._id) },
      query: {},
    });
    ok(founderApprove.status !== 403, "a founder is NOT 403'd by the store gate (real middleware)");
    ok(founderApprove.status === 409, "…the founder's request reached the controller (draft was rejected earlier)");

    // And the REAL Founder role in this database carries a satisfying wildcard.
    const realFounder = await Role.findOne({ systemKey: "founder", deletedAt: null }).lean();
    if (realFounder) {
      ok(
        permissionSatisfies(realFounder.permissions || [], "store:approve:all").allowed === true,
        `the real "${realFounder.name}" role satisfies store:approve:all`,
      );
    } else {
      console.log('  · no systemKey:"founder" role in this database — skipped the live-role check');
    }

    // ── 14. the gate closes on EVERY newly-gated route ──────────────────────
    console.log("14. non-founder without store:approve:all is 403 everywhere");
    const noPerm = { auth: { user_id: String(noPermAdmin._id) }, query: {}, params: {}, body: {} };
    const gatedRoutes = [
      ["POST /decor/drafts/:id/approve", decorDraft.Approve, { params: { id: String(forced._id) } }],
      ["POST /decor/drafts/:id/reject", decorDraft.Reject, { params: { id: String(forced._id) } }],
      ["POST /decor", decor.CreateNew, { body: { name: "X", category: CAT } }],
      ["PUT /decor/:_id", decor.Update, { params: { _id: String(decorIds[0]) }, body: { name: "X" } }],
      ["DELETE /decor/:_id", decor.Delete, { params: { _id: String(decorIds[0]) } }],
      ["PUT /decor/reorder", decor.Reorder, { body: { items: [] } }],
    ];
    for (const [label, handler, extra] of gatedRoutes) {
      const r = await runChain([gate, handler], { ...noPerm, ...extra, auth: noPerm.auth, query: {} });
      ok(r.status === 403, `${label} → 403 without store:approve:all`);
    }
    // the gate is what stopped them — nothing was written
    ok(
      (await Decor.countDocuments({ name: "X" })) === 0,
      "no product was created by the blocked POST /decor",
    );
    ok(!!(await Decor.findById(decorIds[0])), "the blocked DELETE did not remove the product");

    // …and the founder passes the same gate on a catalogue write route.
    const founderCreate = await runChain([gate, decor.CreateNew], {
      auth: { user_id: String(founder._id) },
      query: {},
      params: {},
      body: { name: `${TAG}-founder-made`, category: CAT, unit: "Pc", image: "https://s3.test/x.jpg", thumbnail: "https://s3.test/x.jpg" },
    });
    ok(founderCreate.status === 201, "a founder CAN create a product through the gated route");
    if (founderCreate.body && founderCreate.body.id) decorIds.push(founderCreate.body.id);
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e && e.stack);
  } finally {
    // cleanup
    await DecorDraft.deleteMany({ _id: { $in: draftIds } });
    await Decor.deleteMany({ _id: { $in: decorIds } });
    await Decor.deleteMany({ category: { $in: [CAT, `${TAG}-gen`] } });
    await Decor.deleteMany({ name: `${TAG}-founder-made` });
    await Admin.deleteMany({ _id: { $in: adminIds } });
    await Role.deleteMany({ _id: { $in: roleIds } });
    if (dept) await Department.deleteMany({ _id: dept._id });
    // Leave the database's index state exactly as we found it: the index is a
    // deliberate migration, never a side effect of running tests.
    if (createdIndex) {
      try {
        await mongoose.connection.db.collection("decors").dropIndex("productInfo_id_unique");
        console.log("  · dropped the test-created productInfo_id_unique index");
      } catch (_) {}
    }
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
