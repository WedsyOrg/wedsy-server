// BASELINE LANES test. Run: node tests/baseline-lanes.test.js
// Covers: a qualified lead with ZERO discovery services gets exactly the
// baseline set [lead_comms, engagement, kickoff, venue, decor]; makeup and
// vendor:* are never baseline; idempotency (second call creates nothing, adds
// no entries, touches no owner); a pre-existing owned lane keeps its owner
// while only the missing keys are filled; the lazy GET /lanes hook fires for
// qualified non-lost leads only (unqualified → proposal as before, terminal
// lost → untouched).
require("dotenv").config();
const mongoose = require("mongoose");

const Admin = require("../models/Admin");
const Enquiry = require("../models/Enquiry");
const LeadLane = require("../models/LeadLane");
const LaneEntry = require("../models/LaneEntry");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const LeadLaneService = require("../services/LeadLaneService");
const leadLane = require("../controllers/leadLane");

const TAG = `baselane-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { admins: [], leads: [] };
const BASELINE = ["lead_comms", "engagement", "kickoff", "venue", "decor"];

const call = (fn, req) =>
  new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(body) { resolve({ status: this.statusCode, body }); },
      send(body) { resolve({ status: this.statusCode, body }); },
    };
    fn(req, res);
  });

const mkLead = (suffix, extra = {}) =>
  Enquiry.create({
    name: `${TAG}-${suffix}`, phone: `${TAG}-${suffix}`, verified: false, isInterested: false,
    isLost: false, stage: "qualified", source: "Default", lostStatus: "none", ...extra,
  });

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const owner = await Admin.create({ name: `${TAG}-owner`, email: `${TAG}o@x.com`, phone: `${TAG}o`, password: "x", roles: ["sales"], status: "active" });
    const other = await Admin.create({ name: `${TAG}-other`, email: `${TAG}x@x.com`, phone: `${TAG}x`, password: "x", roles: ["sales"], status: "active" });
    created.admins.push(owner._id, other._id);

    // ── 1. zero services → exactly the baseline set ──
    const lead = await mkLead("bare", { assignedTo: owner._id, qualifiedAt: new Date(), qualificationData: { servicesRequired: [] } });
    created.leads.push(lead._id);
    const r1 = await LeadLaneService.ensureBaselineLanes(lead._id, owner._id);
    ok(r1.created.length === 5 && BASELINE.every((k) => r1.created.includes(k)),
      "no-services lead: all 5 baseline lanes created");
    let lanes = await LeadLane.find({ leadId: lead._id }).lean();
    ok(lanes.length === 5 && BASELINE.every((k) => lanes.some((l) => l.key === k)),
      "exactly the baseline keys exist");
    ok(!lanes.some((l) => l.key === "makeup" || l.key.startsWith("vendor:")),
      "makeup / vendor:* are NOT baseline");
    const lc = lanes.find((l) => l.key === "lead_comms");
    ok(lc && String(lc.ownerId) === String(owner._id), "lead_comms owner forced to the lead owner");

    // ── 1b. venue-booked lead: venue is dropped, the other 4 still ensured ──
    const bookedLead = await mkLead("booked", {
      assignedTo: owner._id, qualifiedAt: new Date(),
      qualificationData: { servicesRequired: [], venueStatus: "booked" },
    });
    created.leads.push(bookedLead._id);
    const rb = await LeadLaneService.ensureBaselineLanes(bookedLead._id, owner._id);
    ok(rb.created.length === 4 && !rb.created.includes("venue"),
      "venue-booked lead: 4 baseline lanes, NO venue");
    const bookedLanes = await LeadLane.find({ leadId: bookedLead._id }).lean();
    ok(bookedLanes.length === 4 && ["lead_comms", "engagement", "kickoff", "decor"].every((k) => bookedLanes.some((l) => l.key === k)),
      "décor + the three standing lanes still ensured for a booked venue");
    // and a repeat stays a no-op (venue never appears later)
    const rb2 = await LeadLaneService.ensureBaselineLanes(bookedLead._id, owner._id);
    ok(rb2.created.length === 0 && !(await LeadLane.findOne({ leadId: bookedLead._id, key: "venue" })),
      "second call on the booked lead: still no venue lane");

    // ── 2. idempotency proof ──
    const entriesBefore = await LaneEntry.countDocuments({ leadId: lead._id });
    const ownersBefore = new Map(lanes.map((l) => [l.key, String(l.ownerId || "")]));
    const r2 = await LeadLaneService.ensureBaselineLanes(lead._id, other._id);
    ok(r2.created.length === 0, "second call creates NOTHING");
    lanes = await LeadLane.find({ leadId: lead._id }).lean();
    ok(lanes.length === 5, "lane count unchanged after second call");
    ok(lanes.every((l) => ownersBefore.get(l.key) === String(l.ownerId || "")),
      "no owner was touched by the second call");
    ok((await LaneEntry.countDocuments({ leadId: lead._id })) === entriesBefore,
      "no new lane entries on the second call");
    ok((await LeadInternalEvent.countDocuments({ leadId: lead._id, type: "team_assembled" })) === 1,
      "team_assembled recorded once (creating call only)");

    // ── 3. partial set: existing owned lane kept, only missing filled ──
    const lead2 = await mkLead("partial", { assignedTo: owner._id, qualifiedAt: new Date() });
    created.leads.push(lead2._id);
    await LeadLaneService.assemble(lead2._id, { lanes: [{ key: "venue", ownerId: String(other._id) }] }, owner._id);
    const r3 = await LeadLaneService.ensureBaselineLanes(lead2._id, owner._id);
    ok(r3.created.length === 4 && !r3.created.includes("venue"),
      "only the 4 missing baseline lanes created");
    const venue2 = await LeadLane.findOne({ leadId: lead2._id, key: "venue" }).lean();
    ok(String(venue2.ownerId) === String(other._id), "the pre-existing venue lane keeps its owner");

    // ── 4. the lazy GET /lanes hook ──
    const lead3 = await mkLead("hook", { assignedTo: owner._id, qualifiedAt: new Date() });
    created.leads.push(lead3._id);
    const g1 = await call(leadLane.List, {
      params: { _id: String(lead3._id) }, query: {},
      auth: { user_id: String(owner._id) }, scopeFilter: {},
    });
    ok(g1.status === 200 && g1.body.lanes.length === 5,
      "GET /lanes on a qualified lead ensures + returns the baseline set");
    const g2 = await call(leadLane.List, {
      params: { _id: String(lead3._id) }, query: {},
      auth: { user_id: String(owner._id) }, scopeFilter: {},
    });
    ok(g2.body.lanes.length === 5, "second GET is a no-op (still 5 lanes)");

    // unqualified lead → proposal path unchanged, nothing created
    const lead4 = await mkLead("unqual", { assignedTo: owner._id, stage: "contacted" });
    created.leads.push(lead4._id);
    const g3 = await call(leadLane.List, {
      params: { _id: String(lead4._id) }, query: {},
      auth: { user_id: String(owner._id) }, scopeFilter: {},
    });
    ok(g3.status === 200 && g3.body.lanes.length === 0 && Array.isArray(g3.body.proposal),
      "unqualified lead: no lanes created, proposal returned as before");

    // terminal-lost qualified lead → untouched
    const lead5 = await mkLead("lost", {
      assignedTo: owner._id, qualifiedAt: new Date(),
      stage: "lost", isLost: true, lostStatus: "approved",
    });
    created.leads.push(lead5._id);
    await call(leadLane.List, {
      params: { _id: String(lead5._id) }, query: {},
      auth: { user_id: String(owner._id) }, scopeFilter: {},
    });
    ok((await LeadLane.countDocuments({ leadId: lead5._id })) === 0,
      "terminal-lost lead: baseline is NOT spawned");
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    if (mongoose.connection.readyState === 1) {
      await LaneEntry.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
      await LeadLane.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
      await LeadInternalEvent.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
      await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
      await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
      await mongoose.disconnect();
    }
    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
