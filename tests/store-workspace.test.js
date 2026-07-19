// STORE WORKSPACE test (S2–S5). Run: node tests/store-workspace.test.js
// Covers: the repaired package PUT (S2), curation orders — addTo order accept,
// removal clears, bulk reorder, ordered reads with createdAt fallback (S3),
// the empirical ghost-field ruling on the decor PUT (S4), and the
// wedding_store quote-queue gate (S5).
require("dotenv").config();
const mongoose = require("mongoose");

const Decor = require("../models/Decor");
const DecorPackage = require("../models/DecorPackage");
const Admin = require("../models/Admin");
const Department = require("../models/Department");
const decorCtl = require("../controllers/decor");
const pkgCtl = require("../controllers/decor-package");
const CsAccessService = require("../services/CsAccessService");
const WorkspaceService = require("../services/WorkspaceService");

const TAG = `store-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

// The legacy decor controllers are promise-chain style (not async): resolve
// when the handler actually calls res.send/json, not when it returns.
const call = (handler, { params = {}, body = {}, query = {}, auth = {} }) =>
  new Promise((resolve, reject) => {
    let statusCode = 200;
    const res = {
      status(c) { statusCode = c; return this; },
      json(p) { resolve({ statusCode, payload: p }); return this; },
      send(p) { resolve({ statusCode, payload: p }); return this; },
    };
    Promise.resolve(handler({ params, body, query, auth }, res)).catch(reject);
  });

const created = { decors: [], packages: [], admins: [] };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const now = Date.now();

    const mkDecor = (s, extra = {}) =>
      Decor.create({
        category: "stage", name: `${TAG}-${s}`, unit: "unit", tags: [],
        image: "x.jpg", thumbnail: "t.jpg", rating: 0,
        pdf: "brochure.pdf",
        seoTags: { title: "seo title", description: "seo desc" },
        productInfo: { SKU: `SKU-${s}`, id: `${TAG}-${s}` },
        ...extra,
      });

    // ── S2: package PUT repaired ──
    const pkg = await DecorPackage.create({ name: `${TAG}-pkg`, description: "old" });
    created.packages.push(pkg._id);
    const up = await call(pkgCtl.Update, { params: { _id: String(pkg._id) }, body: { name: `${TAG}-pkg2`, description: "new", seoTags: { title: "p" } } });
    ok(up.statusCode === 200, "S2 · package PUT no longer 500s (undeclared-var fix)");
    const pkgAfter = await DecorPackage.findById(pkg._id).lean();
    ok(pkgAfter.name === `${TAG}-pkg2` && pkgAfter.description === "new", "S2 · whitelisted fields land");
    const upBad = await call(pkgCtl.Update, { params: { _id: String(pkg._id) }, body: { description: "x" } });
    ok(upBad.statusCode === 400, "S2 · nameless PUT → 400 (validation, not crash)");
    const g = await call(pkgCtl.Get, { params: { _id: String(pkg._id) } });
    ok(g.statusCode === 200 && g.payload.name === `${TAG}-pkg2`, "S2 · package GET works");

    // ── S3: orders ──
    const d1 = await mkDecor("d1", { label: "bestSeller" });
    const d2 = await mkDecor("d2", { label: "bestSeller" });
    const d3 = await mkDecor("d3", { label: "bestSeller" });
    const sp1 = await mkDecor("sp1", { spotlight: true });
    const sp2 = await mkDecor("sp2", { spotlight: true });
    created.decors.push(d1._id, d2._id, d3._id, sp1._id, sp2._id);

    // addTo accepts order
    const add = await call(decorCtl.Update, { params: { _id: String(sp1._id) }, query: { addTo: "spotlight" }, body: { spotlightColor: "#fff", order: 5 } });
    ok(add.statusCode === 200 && (await Decor.findById(sp1._id).lean()).spotlightOrder === 5, "S3 · addTo=spotlight accepts order");
    const addBs = await call(decorCtl.Update, { params: { _id: String(d1._id) }, query: { addTo: "bestSeller" }, body: { order: 2 } });
    ok(addBs.statusCode === 200 && (await Decor.findById(d1._id).lean()).bestSellerOrder === 2, "S3 · addTo=bestSeller accepts order");

    // bulk reorder
    const re = await call(decorCtl.Reorder, { body: { collection: "bestSeller", ids: [String(d3._id), String(d1._id), String(d2._id)] } });
    ok(re.statusCode === 200 && re.payload.ordered === 3, "S3 · reorder acks");
    const [o1, o2, o3] = await Promise.all([d3, d1, d2].map((d) => Decor.findById(d._id).lean()));
    ok(o1.bestSellerOrder === 1 && o2.bestSellerOrder === 2 && o3.bestSellerOrder === 3, "S3 · reorder writes 1-based ranks by position");
    const reBad = await call(decorCtl.Reorder, { body: { collection: "nope", ids: [String(d1._id)] } });
    ok(reBad.statusCode === 400, "S3 · unknown collection → 400");

    // ordered read: label list (no explicit sort) — d3 first now
    const list = await call(decorCtl.GetAll, { query: { label: "bestSeller" } });
    const mineList = list.payload.list.filter((d) => (d.name || "").startsWith(TAG)).map((d) => d.name);
    ok(mineList[0] === `${TAG}-d3` && mineList[1] === `${TAG}-d1` && mineList[2] === `${TAG}-d2`, `S3 · label GET sorts by curation order (${mineList.join(" · ")})`);

    // unordered items fall AFTER ordered ones (createdAt fallback)
    const d4 = await mkDecor("d4", { label: "bestSeller" }); // no order
    created.decors.push(d4._id);
    const list2 = await call(decorCtl.GetAll, { query: { label: "bestSeller" } });
    const mine2 = list2.payload.list.filter((d) => (d.name || "").startsWith(TAG)).map((d) => d.name);
    ok(mine2[mine2.length - 1] === `${TAG}-d4`, "S3 · unordered items sort after ordered (createdAt fallback)");

    // spotlight dedicated branch sorts too
    await call(decorCtl.Update, { params: { _id: String(sp2._id) }, query: { addTo: "spotlight" }, body: { spotlightColor: "#000", order: 1 } });
    const spot = await call(decorCtl.GetAll, { query: { spotlight: "true", random: "false" } });
    const mySpots = spot.payload.list.filter((d) => (d.name || "").startsWith(TAG)).map((d) => d.name);
    ok(mySpots.indexOf(`${TAG}-sp2`) < mySpots.indexOf(`${TAG}-sp1`), "S3 · spotlight GET honors order (1 before 5)");

    // removal clears the rank
    await call(decorCtl.Update, { params: { _id: String(sp1._id) }, query: { removeFrom: "spotlight" } });
    const spGone = await Decor.findById(sp1._id).lean();
    ok(spGone.spotlight === false && spGone.spotlightOrder === null, "S3 · removeFrom=spotlight clears the rank");
    await call(decorCtl.Update, { params: { _id: String(d3._id) }, query: { removeFrom: "bestSeller" } });
    const bsGone = await Decor.findById(d3._id).lean();
    ok(bsGone.label === "" && bsGone.bestSellerOrder === null, "S3 · removeFrom=bestSeller clears label + rank");

    // ── S4: the ghost-field ruling (empirical) ──
    const ghost = await mkDecor("ghost");
    created.decors.push(ghost._id);
    // General PUT omitting pdf/seoTags/productInfo entirely:
    const put1 = await call(decorCtl.Update, {
      params: { _id: String(ghost._id) },
      body: { name: `${TAG}-ghost`, category: "stage", unit: "unit", description: "updated" },
    });
    const after1 = await Decor.findById(ghost._id).lean();
    ok(put1.statusCode === 200 && after1.pdf === "brochure.pdf" && after1.seoTags.title === "seo title" && after1.productInfo.SKU === "SKU-ghost",
      "S4 · OMITTED top-level keys survive (mongoose strips undefined from $set)");
    // Partial nested object → the whole subdoc is replaced:
    await call(decorCtl.Update, {
      params: { _id: String(ghost._id) },
      body: { name: `${TAG}-ghost`, category: "stage", unit: "unit", productInfo: { id: "changed-only" } },
    });
    const after2 = await Decor.findById(ghost._id).lean();
    ok(after2.productInfo.id === "changed-only" && (after2.productInfo.SKU === "" || after2.productInfo.SKU === undefined),
      `S4 · PARTIAL nested productInfo WIPES siblings (SKU="${after2.productInfo.SKU}") — FE must echo nested objects whole`);

    // ── S5: the wedding_store gate ──
    await WorkspaceService.ensureDayOneDepartments();
    const storeDept = await Department.findOne({ slug: "wedding_store", deletedAt: null }).lean();
    ok(!!storeDept, "S1 · wedding_store department seeded (adopt-or-create)");
    const storeAdmin = await Admin.create({ name: `${TAG}-store`, email: `${TAG}s@x.com`, phone: `${TAG}s`, password: "x", roles: ["sales"], status: "active", departmentId: storeDept._id });
    const hatAdmin = await Admin.create({ name: `${TAG}-hat`, email: `${TAG}h@x.com`, phone: `${TAG}h`, password: "x", roles: ["sales"], status: "active", hats: [{ departmentId: storeDept._id }] });
    const rando = await Admin.create({ name: `${TAG}-rando`, email: `${TAG}r@x.com`, phone: `${TAG}r`, password: "x", roles: ["sales"], status: "active" });
    created.admins.push(storeAdmin._id, hatAdmin._id, rando._id);
    ok(await CsAccessService.isDeptMember("wedding_store", storeAdmin._id), "S5 · primary-dept store member passes the probe");
    ok(await CsAccessService.isDeptMember("wedding_store", hatAdmin._id), "S5 · hat-only store member passes the probe");
    ok(!(await CsAccessService.isDeptMember("wedding_store", rando._id)), "S5 · non-member fails the probe (falls to the leads gate)");
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    await Decor.deleteMany({ _id: { $in: created.decors } }).catch(() => {});
    await DecorPackage.deleteMany({ _id: { $in: created.packages } }).catch(() => {});
    await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
    await mongoose.disconnect();
    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
