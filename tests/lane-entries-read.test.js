/**
 * Lane entries read — Slice B3.1. Full thread, at-ascending, roster-aware
 * reads, 404 for a lane that isn't the lead's.
 *
 *   node tests/lane-entries-read.test.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Department = require("../models/Department");
const LeadLane = require("../models/LeadLane");
const LaneEntry = require("../models/LaneEntry");
const LeadTeamMember = require("../models/LeadTeamMember");
const leadLane = require("../controllers/leadLane");

const TAG = `lentries-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const run = (handler, req) =>
  new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); },
      send(b) { resolve({ status: this.statusCode, body: b }); },
    };
    handler(req, res);
  });

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

  const leadIds = [], adminIds = [];
  let dept = null;
  try {
    dept = await Department.create({ name: `${TAG}-dept` });
    const owner = await Admin.create({ name: `${TAG}-owner`, email: `${TAG}o@x.com`, phone: `${TAG}o`, password: "x", status: "active", departmentId: dept._id });
    const rosterer = await Admin.create({ name: `${TAG}-roster`, email: `${TAG}r@x.com`, phone: `${TAG}r`, password: "x", status: "active", departmentId: dept._id });
    const outsider = await Admin.create({ name: `${TAG}-out`, email: `${TAG}x@x.com`, phone: `${TAG}x`, password: "x", status: "active", departmentId: dept._id });
    adminIds.push(owner._id, rosterer._id, outsider._id);

    const lead = await Enquiry.create({ name: "Entries Lead", phone: `${TAG}`, verified: false, isInterested: false, isLost: false, stage: "contacted", source: "Default", assignedTo: owner._id });
    const otherLead = await Enquiry.create({ name: "Other Lead", phone: `${TAG}-2`, verified: false, isInterested: false, isLost: false, stage: "contacted", source: "Default", assignedTo: owner._id });
    leadIds.push(lead._id, otherLead._id);
    await LeadTeamMember.create({ leadId: lead._id, personId: rosterer._id, activeTo: null });

    const lane = await LeadLane.create({ leadId: lead._id, key: "venue", name: "Venue", ownerId: owner._id, state: "active", lastUpdateAt: new Date() });
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) {
      await LaneEntry.create({ laneId: lane._id, leadId: lead._id, kind: i % 2 ? "auto" : "update", autoType: i % 2 ? "call_logged" : "", text: `entry ${i}`, at: new Date(t0 + i * 1000) });
    }

    console.log("1. ordered history");
    const r1 = await run(leadLane.ListEntries, { params: { _id: String(lead._id), laneId: String(lane._id) }, query: {}, scopeFilter: { assignedTo: owner._id }, auth: { user_id: String(owner._id) } });
    ok(r1.status === 200 && r1.body.list.length === 5, `full thread returned (got ${r1.body?.list?.length})`);
    ok(r1.body.list.every((e, i) => e.text === `entry ${i}`), "at-ascending order");
    ok(r1.body.lane.key === "venue", "lane summary attached");

    const r2 = await run(leadLane.ListEntries, { params: { _id: String(lead._id), laneId: String(lane._id) }, query: { limit: "2" }, scopeFilter: { assignedTo: owner._id }, auth: { user_id: String(owner._id) } });
    ok(r2.body.list.length === 2, "?limit honoured");

    console.log("2. scope");
    const r3 = await run(leadLane.ListEntries, { params: { _id: String(lead._id), laneId: String(lane._id) }, query: {}, scopeFilter: { assignedTo: rosterer._id }, auth: { user_id: String(rosterer._id) } });
    ok(r3.status === 200, `roster member can read (got ${r3.status})`);
    const r4 = await run(leadLane.ListEntries, { params: { _id: String(lead._id), laneId: String(lane._id) }, query: {}, scopeFilter: { assignedTo: outsider._id }, auth: { user_id: String(outsider._id) } });
    ok(r4.status === 403, `outsider blocked (got ${r4.status})`);

    console.log("3. cross-lead 404");
    const r5 = await run(leadLane.ListEntries, { params: { _id: String(otherLead._id), laneId: String(lane._id) }, query: {}, scopeFilter: { assignedTo: owner._id }, auth: { user_id: String(owner._id) } });
    ok(r5.status === 404, `lane not on that lead → 404 (got ${r5.status})`);
  } finally {
    if (leadIds.length) {
      await LaneEntry.deleteMany({ leadId: { $in: leadIds } });
      await LeadLane.deleteMany({ leadId: { $in: leadIds } });
      await LeadTeamMember.deleteMany({ leadId: { $in: leadIds } });
      await Enquiry.deleteMany({ _id: { $in: leadIds } });
    }
    if (adminIds.length) await Admin.deleteMany({ _id: { $in: adminIds } });
    if (dept) await Department.deleteMany({ _id: dept._id });
    await mongoose.disconnect();
  }

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("Test harness error:", e); process.exit(1); });
