/**
 * Mission-row ownership — additive decoration on todaysMission.
 *
 * Every mission row (both stores) carries owner {_id,name} (the lead's
 * assignedTo, resolved via ONE batched Admin lookup — no N+1) and isYours
 * (owner === the requesting admin). Journey rows also carry followUpOwner
 * {_id,name} when the Followup's own ownerId differs from the lead owner.
 * No IN/OUT criteria change.
 *
 *   node tests/fix-mission-ownership.test.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Department = require("../models/Department");
const Followup = require("../models/Followup");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const CalendarEvent = require("../models/CalendarEvent");
const CallCockpitService = require("../services/CallCockpitService");
const DashboardService = require("../services/DashboardService");

const TAG = `mission-own-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

  const leadIds = [], adminIds = [];
  let dept = null;
  const origFind = Admin.find;
  try {
    dept = await Department.create({ name: `${TAG}-dept` });
    const manager = await Admin.create({
      name: `${TAG}-manager`, email: `${TAG}-mgr@x.com`, phone: `${TAG}m`,
      password: "x", status: "active", departmentId: dept._id,
    });
    const intern = await Admin.create({
      name: `${TAG}-intern`, email: `${TAG}-int@x.com`, phone: `${TAG}i`,
      password: "x", status: "active", departmentId: dept._id,
      reportingManagerId: manager._id, // the chain: intern reports to manager
    });
    adminIds.push(manager._id, intern._id);

    const overdue = new Date(Date.now() - 2 * 3600 * 1000);
    // Lead A — the MANAGER's own lead, overdue cadence call.
    const leadA = await Enquiry.create({
      name: "Own Lead", phone: `${TAG}-a`, verified: false, isInterested: false,
      isLost: false, stage: "contacted", source: "Default", assignedTo: manager._id,
    });
    // Lead B — the INTERN's lead (in the manager's team scope), overdue cadence
    // call + two journey follow-ups (one owned by the manager ≠ lead owner, one
    // owned by the intern = lead owner).
    const leadB = await Enquiry.create({
      name: "Intern Lead", phone: `${TAG}-b`, verified: false, isInterested: false,
      isLost: false, stage: "contacted", source: "Default", assignedTo: intern._id,
    });
    leadIds.push(leadA._id, leadB._id);
    await CallCockpitService.addFollowUp(leadA._id, { type: "call", scheduledAt: overdue.toISOString() }, manager._id);
    await CallCockpitService.addFollowUp(leadB._id, { type: "call", scheduledAt: overdue.toISOString() }, intern._id);
    // Seeded directly (roster gate is a create-route concern, not a read concern).
    await Followup.create({ leadId: leadB._id, title: "Manager touch", dueAt: overdue, ownerId: manager._id, status: "open" });
    await Followup.create({ leadId: leadB._id, title: "Intern touch", dueAt: overdue, ownerId: intern._id, status: "open" });

    // Spy on Admin.find to prove the ownership lookup is ONE batched query.
    // The ownership call is the name-projected `_id $in` covering BOTH owners
    // (the scope-pool lookup at DashboardService:451 shares the $in shape but
    // carries no projection — excluded by the args[1] check).
    const ownershipCalls = [];
    Admin.find = function (...args) {
      const filter = args[0] || {};
      const projection = args[1] || null;
      const inIds = filter._id && filter._id.$in ? filter._id.$in.map(String) : null;
      if (
        inIds &&
        projection && projection.name === 1 &&
        inIds.includes(String(manager._id)) &&
        inIds.includes(String(intern._id))
      ) {
        ownershipCalls.push(inIds);
      }
      return origFind.apply(this, args);
    };

    // The manager views their TEAM scope (both leads in-scope).
    const dash = await DashboardService.buildDashboard(manager._id, "team", {
      assignedTo: { $in: [manager._id, intern._id] },
    });
    Admin.find = origFind;

    const rows = dash.todaysMission.filter((r) =>
      [String(leadA._id), String(leadB._id)].includes(String(r.leadId))
    );

    console.log("1. own lead → isYours true, named owner");
    const rowA = rows.find((r) => String(r.leadId) === String(leadA._id));
    ok(!!rowA, "manager's lead is in the mission");
    ok(rowA && rowA.isYours === true, "isYours true on the requesting admin's own lead");
    ok(rowA && rowA.owner && rowA.owner.name === `${TAG}-manager`, "owner.name = the manager");
    ok(rowA && String(rowA.owner._id) === String(manager._id), "owner._id = assignedTo");

    console.log("2. intern's lead → isYours false, correct name");
    const rowBCadence = rows.find((r) => String(r.leadId) === String(leadB._id) && r.store === "cadence");
    ok(!!rowBCadence, "intern's cadence row is in the mission");
    ok(rowBCadence && rowBCadence.isYours === false, "isYours false on the subordinate's lead");
    ok(rowBCadence && rowBCadence.owner && rowBCadence.owner.name === `${TAG}-intern`, "owner.name = the intern");

    console.log("3. journey rows → followUpOwner only when it differs");
    const jManager = rows.find((r) => r.store === "journey" && r.title === "Manager touch");
    const jIntern = rows.find((r) => r.store === "journey" && r.title === "Intern touch");
    ok(!!jManager && !!jIntern, "both journey rows present");
    ok(jManager && jManager.owner && jManager.owner.name === `${TAG}-intern`, "journey row's owner is still the LEAD owner (intern)");
    ok(jManager && jManager.followUpOwner && jManager.followUpOwner.name === `${TAG}-manager`,
      "followUpOwner named when the follow-up's ownerId differs from the lead owner");
    ok(jIntern && jIntern.followUpOwner === null, "followUpOwner null when it equals the lead owner");

    console.log("4. batched lookup — no N+1");
    ok(ownershipCalls.length === 1,
      `exactly ONE Admin query resolves every owner across ${rows.length} rows (got ${ownershipCalls.length})`);
  } finally {
    Admin.find = origFind;
    if (leadIds.length) {
      await Followup.deleteMany({ leadId: { $in: leadIds } });
      await LeadInternalEvent.deleteMany({ leadId: { $in: leadIds } });
      await CalendarEvent.deleteMany({ leadId: { $in: leadIds } });
      await Enquiry.deleteMany({ _id: { $in: leadIds } });
    }
    if (adminIds.length) await Admin.deleteMany({ _id: { $in: adminIds } });
    if (dept) await Department.deleteMany({ _id: dept._id });
    await mongoose.disconnect();
  }

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("Test harness error:", e); process.exit(1); });
