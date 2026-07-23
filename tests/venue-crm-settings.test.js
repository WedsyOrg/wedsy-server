// MB-CRM S7 team & permissions backing. Run: node tests/venue-crm-settings.test.js
// Auto-assign settings toggle + wiring the permission matrix to REAL RBAC v2
// bundles (toggling a lead capability on the Sales bundle persists).
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueRole = require("../models/VenueRole");
const settings = require("../controllers/venueCrmSettings");
const roles = require("../controllers/venueRoles");

const TAG = `mbcrm-s7-${Date.now()}`;
const OWNER = new mongoose.Types.ObjectId();
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const created = { venues: [] };

const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const ownerReq = (venue, extra = {}) => ({ params: { slug: venue.slug, ...(extra.params || {}) }, query: {}, body: extra.body || {}, venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: OWNER }, venueMember: null });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const venue = await Venue.create({ name: `${TAG}-v`, slug: `${TAG}-v` });
    created.venues.push(venue._id);

    // ── auto-assign settings ──
    const g0 = await call(settings.getCrmSettings, ownerReq(venue));
    ok(g0.code === 200 && g0.body.autoAssignLeads === false, "auto-assign defaults off");
    const p1 = await call(settings.updateCrmSettings, ownerReq(venue, { body: { autoAssignLeads: true } }));
    ok(p1.code === 200 && p1.body.autoAssignLeads === true, "auto-assign toggles on");
    const g1 = await call(settings.getCrmSettings, ownerReq(venue));
    ok(g1.body.autoAssignLeads === true, "toggle persists");
    const bad = await call(settings.updateCrmSettings, ownerReq(venue, { body: { autoAssignLeads: "yes" } }));
    ok(bad.code === 400, "non-boolean rejected");

    // ── matrix wired to real bundles ──
    const list = await call(roles.listRoles, ownerReq(venue));
    ok(list.code === 200 && Array.isArray(list.body.roles), "roles list seeds the venue bundles");
    ok(list.body.capabilities.includes("leads_view_all"), "the new lead capabilities are exposed to the matrix");
    const owner = list.body.roles.find((r) => r.isSystem);
    ok(owner && owner.capabilities.includes("leads_view_all"), "the system Owner bundle has every capability");
    const sales = list.body.roles.find((r) => r.name === "Sales");
    ok(sales && !sales.capabilities.includes("leads_view_all"), "Sales bundle starts WITHOUT leads_view_all (scoped)");

    // toggle "See all leads" ON for Sales via the real updateRole path
    const nextCaps = [...sales.capabilities, "leads_view_all"];
    const upd = await call(roles.updateRole, ownerReq(venue, { params: { roleId: String(sales._id) }, body: { capabilities: nextCaps } }));
    ok(upd.code === 200 && upd.body.role.capabilities.includes("leads_view_all"), "toggling a matrix cell edits the REAL Sales bundle");
    const reread = await VenueRole.findById(sales._id).lean();
    ok(reread.capabilities.includes("leads_view_all"), "the change is persisted to the bundle");

    // Owner bundle is immutable
    const denyOwner = await call(roles.updateRole, ownerReq(venue, { params: { roleId: String(owner._id) }, body: { capabilities: ["leads"] } }));
    ok(denyOwner.code === 403, "the Owner bundle cannot be edited (immutable)");
  } catch (err) {
    console.error("FATAL", err);
    fail++;
  } finally {
    try {
      const vids = created.venues;
      await VenueRole.deleteMany({ venue: { $in: vids } });
      await Venue.deleteMany({ _id: { $in: vids } });
    } catch (e) { console.error("cleanup error", e.message); }
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
