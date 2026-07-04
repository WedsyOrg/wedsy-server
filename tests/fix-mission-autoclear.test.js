/**
 * Mission auto-clear on call log — Signal Matrix Slice 7.
 *
 * A due/overdue "call" next step showed red in Today's Mission even after the
 * rep logged the call: nothing completed the embedded follow-up. logCall now
 * auto-completes DUE embedded call-type follow-ups (completedOutcome
 * "auto:<outcome>", gate-exempt by design — the cadence engine handles the
 * next attempt). Meet/visit rows and FUTURE call rows are never touched.
 *
 *   node tests/fix-mission-autoclear.test.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Department = require("../models/Department");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const AdminNotification = require("../models/AdminNotification");
const CalendarEvent = require("../models/CalendarEvent");
const CallCockpitService = require("../services/CallCockpitService");
const DashboardService = require("../services/DashboardService");

const TAG = `autoclear-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

  const leadIds = [], adminIds = [];
  let dept = null;
  try {
    dept = await Department.create({ name: `${TAG}-dept` });
    const actor = await Admin.create({
      name: `${TAG}-actor`, email: `${TAG}@x.com`, phone: `${TAG}a`,
      password: "x", status: "active", departmentId: dept._id,
    });
    adminIds.push(actor._id);

    const lead = await Enquiry.create({
      name: "Autoclear Lead", phone: `${TAG}`, verified: false, isInterested: false,
      isLost: false, stage: "contacted", source: "Default", assignedTo: actor._id,
    });
    leadIds.push(lead._id);

    // Three embedded follow-ups: overdue call (should clear), overdue meet
    // (must survive — a call doesn't do a meeting), future call (must survive).
    const overdue = new Date(Date.now() - 3 * 3600 * 1000);
    const future = new Date(Date.now() + 24 * 3600 * 1000);
    await CallCockpitService.addFollowUp(lead._id, { type: "call", scheduledAt: overdue.toISOString(), promiseNote: "chase" }, actor._id);
    await CallCockpitService.addFollowUp(lead._id, { type: "meet", scheduledAt: overdue.toISOString() }, actor._id);
    await CallCockpitService.addFollowUp(lead._id, { type: "call", scheduledAt: future.toISOString() }, actor._id);

    // ── 0. Precondition: the overdue rows show red in the mission.
    console.log("0. red rows before the call");
    const dash0 = await DashboardService.buildDashboard(actor._id, "own", { assignedTo: actor._id });
    const mission0 = dash0.todaysMission.filter((r) => String(r.leadId) === String(lead._id));
    ok(mission0.filter((r) => r.overdue).length === 2, "two overdue rows (call + meet) before the call");

    // ── 1. Log the call → ONLY the due call row auto-completes.
    console.log("1. logCall clears the due call row only");
    await CallCockpitService.logCall(
      lead._id,
      { startedAt: new Date().toISOString(), durationSeconds: 120, connected: true, outcome: "", notes: "spoke, sending options" },
      actor._id
    );
    const after = await Enquiry.findById(lead._id).lean();
    const byType = (t, when) => after.followUps.find((f) => f.type === t && +new Date(f.scheduledAt) === +when);
    const dueCall = byType("call", overdue);
    const dueMeet = byType("meet", overdue);
    const futCall = byType("call", future);
    ok(!!dueCall.completedAt, "overdue call follow-up auto-completed");
    ok(dueCall.completedOutcome === "auto:connected", `completedOutcome = auto:connected (got ${dueCall.completedOutcome})`);
    ok(String(dueCall.completedBy) === String(actor._id), "completedBy = the caller");
    ok(!dueMeet.completedAt, "overdue MEET follow-up untouched (a call is not a meeting)");
    ok(!futCall.completedAt, "FUTURE call follow-up untouched");

    // ── 2. Mission: the call row is gone, the meet row still red.
    console.log("2. mission reflects it");
    const dash1 = await DashboardService.buildDashboard(actor._id, "own", { assignedTo: actor._id });
    const mission1 = dash1.todaysMission.filter((r) => String(r.leadId) === String(lead._id));
    ok(!mission1.some((r) => r.type === "call" && r.overdue), "no red call row after logging the call");
    ok(mission1.some((r) => r.type === "meet" && r.overdue), "meet row still red (still owed)");

    // ── 3. Journey renders the auto-completion from the raw row (Slice 1
    //      made followUps[] the single renderer — no extra event needed).
    const { buildJourney } = require("../services/JourneyService");
    const journey = await buildJourney(lead._id);
    const doneRows = journey.entries.filter((e) => e.type === "follow_up_done");
    ok(doneRows.length === 1 && doneRows[0].detail.outcome === "auto:connected",
      "journey shows exactly one follow-up-done row with the auto outcome");
  } finally {
    if (leadIds.length) {
      await LeadInternalEvent.deleteMany({ leadId: { $in: leadIds } });
      await AdminNotification.deleteMany({ leadId: { $in: leadIds } });
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
