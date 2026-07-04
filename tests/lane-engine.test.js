/**
 * Lane engine — Slice B3.
 *
 *   node tests/lane-engine.test.js
 *
 * Covers: proposal derivation (services → lanes, booked venue skipped),
 * assemble idempotency + the locked lead_comms owner, entry heartbeats
 * (lane.lastUpdateAt + Enquiry.lastActivityAt), state-transition validation,
 * task laneId + completion auto entry, the logCall hook (present + fire-safe
 * absent), and the lane-owner write guard.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Department = require("../models/Department");
const LeadLane = require("../models/LeadLane");
const LaneEntry = require("../models/LaneEntry");
const LeadTask = require("../models/LeadTask");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const LeadChatMessage = require("../models/LeadChatMessage");
const AdminNotification = require("../models/AdminNotification");
const LeadLaneService = require("../services/LeadLaneService");
const LeadTaskService = require("../services/LeadTaskService");
const CallCockpitService = require("../services/CallCockpitService");
const leadLane = require("../controllers/leadLane");

const TAG = `lane-${Date.now()}`;
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
    const laneOwner = await Admin.create({ name: `${TAG}-laneowner`, email: `${TAG}l@x.com`, phone: `${TAG}l`, password: "x", status: "active", departmentId: dept._id });
    const outsider = await Admin.create({ name: `${TAG}-outsider`, email: `${TAG}x@x.com`, phone: `${TAG}x`, password: "x", status: "active", departmentId: dept._id });
    adminIds.push(owner._id, laneOwner._id, outsider._id);

    const lead = await Enquiry.create({
      name: "Lane Lead", phone: `${TAG}`, verified: false, isInterested: false, isLost: false,
      stage: "meeting_scheduled", source: "Default", assignedTo: owner._id, qualified: true,
      qualificationData: { servicesRequired: ["Venue", "Décor", "Photography"], venueStatus: "" },
    });
    const leadBooked = await Enquiry.create({
      name: "Booked Venue Lead", phone: `${TAG}-b`, verified: false, isInterested: false, isLost: false,
      stage: "meeting_scheduled", source: "Default", assignedTo: owner._id, qualified: true,
      qualificationData: { servicesRequired: ["Venue", "Makeup"], venueStatus: "booked", venueName: "Taj" },
    });
    leadIds.push(lead._id, leadBooked._id);

    // ── 1. Proposal derivation.
    console.log("1. proposal derivation");
    const p1 = await LeadLaneService.listLanes(lead._id);
    const keys1 = p1.proposal.map((p) => p.key);
    ok(p1.lanes.length === 0 && p1.proposal.length > 0, "no lanes yet → proposal returned");
    ok(keys1.includes("venue") && keys1.includes("decor") && keys1.includes("vendors"), "services map to venue + decor + vendors (photography → vendors)");
    ok(keys1.includes("lead_comms") && keys1.includes("engagement") && keys1.includes("kickoff"), "standing lanes present");
    const lc = p1.proposal.find((p) => p.key === "lead_comms");
    ok(lc.locked === true && String(lc.suggestedOwnerId) === String(owner._id), "lead_comms locked to the lead owner");

    const p2 = await LeadLaneService.listLanes(leadBooked._id);
    ok(!p2.proposal.some((p) => p.key === "venue"), "booked venue → NO venue lane proposed");
    ok(p2.proposal.some((p) => p.key === "makeup"), "makeup still proposed");

    // ── 2. Assemble: forced lead_comms owner + idempotency.
    console.log("2. assemble");
    await LeadLaneService.assemble(lead._id, {
      lanes: [
        { key: "venue", name: "Venue", ownerId: String(laneOwner._id) },
        { key: "lead_comms", name: "Lead communication", ownerId: String(outsider._id) }, // must be overridden
        { key: "vendors", name: "Vendors", state: "queued", wake: { type: "afterLane", laneKey: "venue" } },
      ],
    }, owner._id);
    let lanes = await LeadLane.find({ leadId: lead._id }).lean();
    ok(lanes.length === 3, "three lanes created");
    const lcLane = lanes.find((l) => l.key === "lead_comms");
    ok(String(lcLane.ownerId) === String(owner._id), "lead_comms owner FORCED to assignedTo (client value ignored)");
    const opened = await LaneEntry.countDocuments({ leadId: lead._id, autoType: "lane_opened" });
    ok(opened === 3, 'auto "Lane opened" entry per lane');
    const ev = await LeadInternalEvent.find({ leadId: lead._id, type: "team_assembled" }).lean();
    ok(ev.length === 1 && ev[0].payload.count === 3, "team_assembled journey event");

    await LeadLaneService.assemble(lead._id, { lanes: [{ key: "venue", name: "Venue again" }] }, owner._id);
    lanes = await LeadLane.find({ leadId: lead._id }).lean();
    ok(lanes.length === 3 && lanes.find((l) => l.key === "venue").name === "Venue", "re-assemble is idempotent per key");

    // ── 3. Entry heartbeat.
    console.log("3. entry bumps both timestamps");
    const venueLane = lanes.find((l) => l.key === "venue");
    const beforeLead = await Enquiry.findById(lead._id, { lastActivityAt: 1 }).lean();
    await new Promise((r) => setTimeout(r, 20));
    await LeadLaneService.addEntry(lead._id, venueLane._id, { text: "3 venues shortlisted" }, laneOwner._id);
    const afterLane = await LeadLane.findById(venueLane._id).lean();
    const afterLead = await Enquiry.findById(lead._id, { lastActivityAt: 1 }).lean();
    ok(+new Date(afterLane.lastUpdateAt) > +new Date(venueLane.lastUpdateAt), "lane.lastUpdateAt bumped");
    ok(+new Date(afterLead.lastActivityAt || 0) > +new Date(beforeLead.lastActivityAt || 0), "Enquiry.lastActivityAt bumped");

    // ── 4. State transitions.
    console.log("4. transitions");
    const vendorsLane = lanes.find((l) => l.key === "vendors"); // queued
    let bad = null;
    try { await LeadLaneService.patchLane(lead._id, vendorsLane._id, { state: "paused" }); } catch (e) { bad = e.status; }
    ok(bad === 422, `queued→paused rejected (got ${bad})`);
    await LeadLaneService.patchLane(lead._id, venueLane._id, { state: "paused", pausedReason: "waiting on client" });
    let v = await LeadLane.findById(venueLane._id).lean();
    ok(v.state === "paused" && v.pausedReason === "waiting on client", "active→paused with reason");
    await LeadLaneService.patchLane(lead._id, venueLane._id, { state: "active" });
    v = await LeadLane.findById(venueLane._id).lean();
    ok(v.state === "active" && v.pausedReason === "" && v.wake == null, "paused→active clears reason + wake");
    await LeadLaneService.patchLane(lead._id, vendorsLane._id, { state: "done" });
    ok((await LeadLane.findById(vendorsLane._id).lean()).state === "done", "any→done allowed");

    // ── 5. Task laneId + completion echo.
    console.log("5. lane task");
    const task = await LeadTaskService.createTask(
      lead._id,
      { title: "Confirm Taj slot", assigneeId: laneOwner._id, dueAt: new Date(Date.now() + 86400000).toISOString(), laneId: String(venueLane._id) },
      owner._id
    );
    ok(String(task.laneId) === String(venueLane._id), "task stores laneId");
    await LeadTaskService.completeTask(task._id, laneOwner._id);
    const doneEntries = await LaneEntry.find({ laneId: venueLane._id, autoType: "task_done" }).lean();
    ok(doneEntries.length === 1 && /Confirm Taj slot/.test(doneEntries[0].text), "completion writes a task_done auto entry in the lane");

    // ── 6. logCall hook (present + fire-safe when absent).
    console.log("6. logCall hook");
    await CallCockpitService.logCall(lead._id, { startedAt: new Date().toISOString(), durationSeconds: 60, connected: true, outcome: "", purpose: "follow_up" }, owner._id);
    const callEntries = await LaneEntry.find({ laneId: lcLane._id, autoType: "call_logged" }).lean();
    ok(callEntries.length === 1, "call echoes into lead_comms");
    // No lanes on leadBooked — the hook must be a silent no-op.
    await CallCockpitService.logCall(leadBooked._id, { startedAt: new Date().toISOString(), durationSeconds: 5, connected: false, outcome: "busy" }, owner._id);
    ok((await LaneEntry.countDocuments({ leadId: leadBooked._id })) === 0, "no lanes → hook is a fire-safe no-op");

    // ── 7. Write guard: lane owner may write their lane; outsider 403.
    console.log("7. lane-owner write guard");
    const rOwn = await run(leadLane.AddEntry, {
      params: { _id: String(lead._id), laneId: String(venueLane._id) },
      scopeFilter: { assignedTo: laneOwner._id }, // own scope — NOT the lead owner
      auth: { user_id: String(laneOwner._id) },
      body: { text: "Bride loved the garden lawn" },
    });
    ok(rOwn.status === 201, `lane owner posts to their lane (got ${rOwn.status})`);
    const rOut = await run(leadLane.AddEntry, {
      params: { _id: String(lead._id), laneId: String(venueLane._id) },
      scopeFilter: { assignedTo: outsider._id },
      auth: { user_id: String(outsider._id) },
      body: { text: "nope" },
    });
    ok(rOut.status === 403, `non-owner non-scoped caller 403s (got ${rOut.status})`);
  } finally {
    if (leadIds.length) {
      await LaneEntry.deleteMany({ leadId: { $in: leadIds } });
      await LeadLane.deleteMany({ leadId: { $in: leadIds } });
      await LeadTask.deleteMany({ leadId: { $in: leadIds } });
      await LeadInternalEvent.deleteMany({ leadId: { $in: leadIds } });
      await LeadChatMessage.deleteMany({ leadId: { $in: leadIds } });
      await AdminNotification.deleteMany({ leadId: { $in: leadIds } });
      await Enquiry.deleteMany({ _id: { $in: leadIds } });
    }
    if (adminIds.length) await Admin.deleteMany({ _id: { $in: adminIds } });
    if (dept) await Department.deleteMany({ _id: dept._id });
    await mongoose.disconnect();
  }

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("Test harness error:", e); process.exit(1); });
