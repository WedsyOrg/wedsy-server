/**
 * Recover lost lead — EnquiryService.recoverLead (POST /enquiry/:_id/recover).
 *
 * recoverLead un-losts an APPROVED-lost lead back into the pipeline: it resets the
 * ACTIVE lost state (lostStatus → "none", isLost → false, stageBeforeLost → "") and
 * restores stage = stageBeforeLost || "new", while KEEPING every lost audit field
 * (lostReason / lostRequestedBy / lostRequestedAt / lostDecidedBy / lostDecidedAt /
 * lostDecisionNote) so the history of what happened survives. A non-approved-lost
 * lead is rejected with httpError 400 "Lead is not lost".
 *
 *   node tests/recover-lost-lead.test.js
 *
 * Seeds isolated, uniquely-tagged docs against the local CRM DB and cleans up in
 * finally. AdminNotificationService.notify is SPIED (not invoked for real), so the
 * test never depends on seeded managers / Revenue Heads — it just records the call.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const ActivityLog = require("../models/ActivityLog");
const AdminNotificationService = require("../services/AdminNotificationService");
const EnquiryService = require("../services/EnquiryService");

const TAG = `recover-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

// A fully-populated APPROVED-lost lead, including the audit fields the recover must keep.
const makeLostLead = (suffix, { stageBeforeLost }) =>
  Enquiry.create({
    name: "Test Couple", phone: `${TAG}-${suffix}`, verified: false, isInterested: false,
    source: "Default",
    // active lost state:
    isLost: true, stage: "lost", lostStatus: "approved", stageBeforeLost,
    // audit trail (must survive recover untouched):
    lostReason: "budget", lostNote: "too low",
    lostRequestedBy: new mongoose.Types.ObjectId(), lostRequestedAt: new Date("2026-06-01T10:00:00Z"),
    lostDecidedBy: new mongoose.Types.ObjectId(), lostDecidedAt: new Date("2026-06-02T10:00:00Z"),
    lostDecisionNote: "approved by manager",
  });

const makeOpenLead = (suffix) =>
  Enquiry.create({
    name: "Open Couple", phone: `${TAG}-${suffix}`, verified: false, isInterested: false,
    isLost: false, stage: "meeting_scheduled", source: "Default", lostStatus: "none",
  });

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

  // ── Spy on the internal notifier so the test is independent of real admins.
  const origNotify = AdminNotificationService.notify;
  let notifyCalls = [];
  AdminNotificationService.notify = async (recipients, payload) => {
    notifyCalls.push({ recipients, payload });
  };

  const leadIds = [];
  try {
    // ── Case 1: approved-lost WITH stageBeforeLost → restored to that stage.
    console.log("Case 1: recover restores to stageBeforeLost and clears the active lost state");
    notifyCalls = [];
    const l1 = await makeLostLead("c1", { stageBeforeLost: "meeting_scheduled" });
    leadIds.push(l1._id);
    const r1 = await EnquiryService.recoverLead(l1._id, l1.lostDecidedBy);
    ok(r1.lostStatus === "none", "lostStatus → none");
    ok(r1.isLost === false, "isLost → false");
    ok(r1.stage === "meeting_scheduled", "stage === stageBeforeLost (meeting_scheduled)");
    ok(r1.stageBeforeLost === "", "stageBeforeLost cleared");
    // Audit fields survive (Case 2 coverage, asserted on the recovered doc):
    ok(r1.lostReason === "budget", "lostReason kept");
    ok(String(r1.lostRequestedBy) === String(l1.lostRequestedBy), "lostRequestedBy kept");
    ok(r1.lostRequestedAt && r1.lostRequestedAt.getTime() === l1.lostRequestedAt.getTime(), "lostRequestedAt kept");
    ok(String(r1.lostDecidedBy) === String(l1.lostDecidedBy), "lostDecidedBy kept");
    ok(r1.lostDecidedAt && r1.lostDecidedAt.getTime() === l1.lostDecidedAt.getTime(), "lostDecidedAt kept");
    ok(r1.lostDecisionNote === "approved by manager", "lostDecisionNote kept");
    // Re-read from the DB to confirm the audit fields are persisted (not just on the return value):
    const reread1 = await Enquiry.findById(l1._id).lean();
    ok(reread1.lostReason === "budget" && reread1.lostStatus === "none", "DB row: audit kept + lostStatus none");
    // ActivityLog written:
    const log1 = await ActivityLog.find({ entityId: String(l1._id), action: "lead.recovered" }).lean();
    ok(log1.length === 1, "exactly one lead.recovered ActivityLog row");
    ok(log1.length === 1 && log1[0].meta && log1[0].meta.restoredStage === "meeting_scheduled", "log meta.restoredStage correct");
    ok(log1.length === 1 && log1[0].meta && log1[0].meta.hadStageBeforeLost === true, "log meta.hadStageBeforeLost true");
    // Notify fired (spied) with the recovered payload:
    ok(notifyCalls.length === 1, "AdminNotificationService.notify called exactly once");
    ok(notifyCalls.length === 1 && notifyCalls[0].payload.type === "lead_recovered", "notify type = lead_recovered");
    ok(notifyCalls.length === 1 && notifyCalls[0].payload.title === `Lead recovered: ${l1.name}`, "notify title names the lead");
    ok(notifyCalls.length === 1 && String(notifyCalls[0].payload.leadId) === String(l1._id), "notify leadId correct");

    // ── Case 1b: approved-lost WITHOUT stageBeforeLost → fallback to "new".
    console.log("Case 1b: empty stageBeforeLost falls back to \"new\"");
    notifyCalls = [];
    const l2 = await makeLostLead("c2", { stageBeforeLost: "" });
    leadIds.push(l2._id);
    const r2 = await EnquiryService.recoverLead(l2._id, l2.lostDecidedBy);
    ok(r2.lostStatus === "none", "lostStatus → none (fallback case)");
    ok(r2.isLost === false, "isLost → false (fallback case)");
    ok(r2.stage === "new", "stage falls back to \"new\" when stageBeforeLost empty");
    const log2 = await ActivityLog.find({ entityId: String(l2._id), action: "lead.recovered" }).lean();
    ok(log2.length === 1 && log2[0].meta.hadStageBeforeLost === false, "log meta.hadStageBeforeLost false on fallback");

    // ── Case 3: a non-lost lead → httpError 400, no writes, no notify.
    console.log("Case 3: recovering a non-lost lead is rejected with 400");
    notifyCalls = [];
    const l3 = await makeOpenLead("c3");
    leadIds.push(l3._id);
    let threw = null;
    try {
      await EnquiryService.recoverLead(l3._id, new mongoose.Types.ObjectId());
    } catch (e) {
      threw = e;
    }
    ok(threw !== null, "recoverLead throws on a non-lost lead");
    ok(threw && threw.status === 400, "error status === 400");
    ok(threw && threw.message === "Lead is not lost", "error message === \"Lead is not lost\"");
    const reread3 = await Enquiry.findById(l3._id).lean();
    ok(reread3.lostStatus === "none" && reread3.stage === "meeting_scheduled", "non-lost lead untouched");
    ok(notifyCalls.length === 0, "no notify on the rejected path");
  } finally {
    AdminNotificationService.notify = origNotify; // restore the spy
    if (leadIds.length) {
      await ActivityLog.deleteMany({ entityId: { $in: leadIds.map(String) } });
      await Enquiry.deleteMany({ _id: { $in: leadIds } });
    }
    await mongoose.disconnect();
  }

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("Test harness error:", e); process.exit(1); });
