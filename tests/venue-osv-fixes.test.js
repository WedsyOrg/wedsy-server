// MB-OSV pre-merge fixes — the three review flags, pinned so they cannot come back.
// Run: node tests/venue-osv-fixes.test.js
//
//   1. The OWNER PORTAL dashboard reads the Track A boolean, not the retired
//      publication status. The bug: the OS writes verified.isVerified and
//      leaves `status` alone, so `status === "verified"` reported a freshly
//      verified venue as UNVERIFIED to its own owner, indefinitely.
//   2. listLeadAssists applies the caller's RBAC scope filter, so an admin
//      scoped to their own leads cannot read couple name/phone for every
//      assisted lead through this path.
//   3. createLeadAssist 404s on an enquiryId that resolves to nothing.
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueOwner = require("../models/VenueOwner");
const VenueLeadAssist = require("../models/VenueLeadAssist");
const VenueActivity = require("../models/VenueActivity");
const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");

const dash = require("../controllers/venueDashboard");
const p = require("../controllers/adminVenuePartnership");
const { requirePermission } = require("../middlewares/requirePermission");

const TAG = `osv-fix-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const adminReq = (adminId, extra = {}) => ({
  params: extra.params || {}, query: extra.query || {}, body: extra.body || {},
  auth: { user_id: adminId },
  ...(extra.scopeFilter !== undefined ? { scopeFilter: extra.scopeFilter, scope: extra.scope } : {}),
});
const ownerReq = (venue, ownerId) => ({ venueOwner: { venueId: venue._id, venueOwnerId: ownerId } });
const call = async (fn, r) => { const res = mockRes(); await fn(r, res); return res; };

const created = { venues: [], owners: [], admins: [], roles: [], depts: [], leads: [] };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    const dept = await Department.create({ name: `${TAG}-dept` });
    created.depts.push(dept._id);
    const founderRole = await Role.create({ name: `${TAG}-founder`, departmentId: dept._id, permissions: ["*:*:all"] });
    // Holds the venue-assist capability but is scoped to their OWN leads on the
    // CRM side — the exact shape the leak would have exposed.
    const scopedRole = await Role.create({
      name: `${TAG}-scoped`, departmentId: dept._id,
      permissions: ["venues:view:all", "venues_leads_assist:view:own", "venues_leads_assist:create:all", "leads:view:own"],
    });
    created.roles.push(founderRole._id, scopedRole._id);
    const founder = await Admin.create({ name: `${TAG}-f`, email: `${TAG}-f@w.in`, phone: `${TAG}1`, password: "x", roleIds: [founderRole._id], departmentId: dept._id });
    const scoped = await Admin.create({ name: `${TAG}-s`, email: `${TAG}-s@w.in`, phone: `${TAG}2`, password: "x", roleIds: [scopedRole._id], departmentId: dept._id });
    created.admins.push(founder._id, scoped._id);

    // ── 1. owner dashboard reads the Track A boolean ────────────────────────
    console.log("\n[1] owner portal reports what the OS actually set");

    const venue = await Venue.create({ name: `${TAG}-v`, slug: `${TAG}-v`, status: "published" });
    created.venues.push(venue._id);
    const owner = await VenueOwner.create({ name: `${TAG}-o`, phone: `9${String(Date.now()).slice(-9)}`, venueId: venue._id, verificationStatus: "verified", isActive: true });
    created.owners.push(owner._id);

    let d = await call(dash.getDashboardOverview, ownerReq(venue, owner._id));
    ok(d.code === 200, "dashboard → 200");
    ok(d.body.isVerified === false, "an unverified published venue reads false");

    // The OS verifies it — through the real route, which never touches status.
    const v = await call(p.setVerified, adminReq(founder._id, { params: { slug: venue.slug }, body: { isVerified: true, notes: "checked" } }));
    ok(v.code === 200 && v.body.verifiedBadge === true, "OS verify → 200, badge lit");
    const fresh = await Venue.findById(venue._id).lean();
    ok(fresh.status === "published", "…and the publication status is UNCHANGED");

    d = await call(dash.getDashboardOverview, ownerReq(venue, owner._id));
    ok(d.body.isVerified === true, "THE FIX: the owner's dashboard now reports verified");

    // Revoking has to propagate the same way.
    await call(p.setVerified, adminReq(founder._id, { params: { slug: venue.slug }, body: { isVerified: false } }));
    d = await call(dash.getDashboardOverview, ownerReq(venue, owner._id));
    ok(d.body.isVerified === false, "…and an unverify propagates too");

    // A pre-backfill legacy venue must still read verified through the fallback.
    const legacy = await Venue.create({ name: `${TAG}-legacy`, slug: `${TAG}-legacy`, status: "verified" });
    created.venues.push(legacy._id);
    const legacyOwner = await VenueOwner.create({ name: `${TAG}-lo`, phone: `8${String(Date.now()).slice(-9)}`, venueId: legacy._id, verificationStatus: "verified", isActive: true });
    created.owners.push(legacyOwner._id);
    const dl = await call(dash.getDashboardOverview, ownerReq(legacy, legacyOwner._id));
    ok(dl.body.isVerified === true, "a pre-backfill legacy venue still reads verified (fallback intact)");

    // ── 2. lead-assist reads honour the caller's scope ──────────────────────
    console.log("\n[2] lead assists respect RBAC scope");

    const leadA = await Enquiry.create({ name: `${TAG} Couple A`, phone: `77${String(Date.now()).slice(-8)}`, stage: "contacted" });
    const leadB = await Enquiry.create({ name: `${TAG} Couple B`, phone: `66${String(Date.now()).slice(-8)}`, stage: "contacted" });
    created.leads.push(leadA._id, leadB._id);

    const mine = await call(p.createLeadAssist, adminReq(scoped._id, { body: { slug: venue.slug, enquiryId: String(leadA._id) } }));
    ok(mine.code === 201, "scoped admin creates their own assist → 201");
    const theirs = await call(p.createLeadAssist, adminReq(founder._id, { body: { slug: venue.slug, enquiryId: String(leadB._id) } }));
    ok(theirs.code === 201, "founder creates a different assist → 201");

    // The gate computes the scope filter; the handler must USE it.
    const gate = async (perm, adminId) => {
      const r = adminReq(adminId);
      const res = mockRes();
      let ran = false;
      await requirePermission(perm, { ownerField: "adminId" })(r, res, () => { ran = true; });
      return { ran, req: r, code: res.code };
    };

    const scopedGate = await gate("venues_leads_assist:view:own", scoped._id);
    ok(scopedGate.ran, "scoped admin passes the view gate at own scope");
    ok(scopedGate.req.scope === "own", "…with effectiveScope 'own'");
    const scopedList = await call(p.listLeadAssists, { ...scopedGate.req, query: { all: "1" } });
    ok(scopedList.code === 200, "list → 200");
    ok(scopedList.body.total === 1, `THE FIX: ?all=1 still returns only their own (got ${scopedList.body.total})`);
    ok(
      scopedList.body.assists.every((a) => String(a.adminId._id || a.adminId) === String(scoped._id)),
      "…and every row belongs to the caller"
    );
    ok(
      !JSON.stringify(scopedList.body).includes("Couple B"),
      "…so another admin's couple never appears in the payload"
    );

    // Explicitly asking for someone else's assists must not widen the scope.
    const impersonate = await call(p.listLeadAssists, { ...scopedGate.req, query: { adminId: String(founder._id) } });
    ok(impersonate.body.total === 0, "…and naming another adminId cannot widen it either");

    // An `all`-scoped caller legitimately sees everything.
    const founderGate = await gate("venues_leads_assist:view:all", founder._id);
    ok(founderGate.req.scope === "all", "founder resolves to 'all' scope");
    const founderList = await call(p.listLeadAssists, { ...founderGate.req, query: { all: "1" } });
    ok(founderList.body.total >= 2, "an all-scoped admin still sees every assist");

    // ── 3. createLeadAssist validates the lead exists ───────────────────────
    console.log("\n[3] assists cannot point at a lead that does not exist");
    const ghost = await call(p.createLeadAssist, adminReq(founder._id, {
      body: { slug: venue.slug, enquiryId: String(new mongoose.Types.ObjectId()) },
    }));
    ok(ghost.code === 404, "a well-formed but non-existent enquiryId → 404");
    ok(/lead/i.test(ghost.body.message || ""), "…and the message names the lead");
    const malformed = await call(p.createLeadAssist, adminReq(founder._id, { body: { slug: venue.slug, enquiryId: "not-an-id" } }));
    ok(malformed.code === 400, "a malformed enquiryId is still a 400, not a 404");

  } catch (e) {
    fail++;
    console.error("\nFATAL", e);
  } finally {
    await Promise.all([
      Venue.deleteMany({ _id: { $in: created.venues } }),
      VenueOwner.deleteMany({ _id: { $in: created.owners } }),
      VenueLeadAssist.deleteMany({ venue: { $in: created.venues } }),
      Enquiry.deleteMany({ _id: { $in: created.leads } }),
      Admin.deleteMany({ _id: { $in: created.admins } }),
      Role.deleteMany({ _id: { $in: created.roles } }),
      Department.deleteMany({ _id: { $in: created.depts } }),
    ]).catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
