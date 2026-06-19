/**
 * FIX #3 — notify the reporting manager when a lead is disqualified.
 *
 * Service (EnquiryService.requestDisqualification): ADDITIVE only — after the
 * existing state write + ActivityLogService audit row, it notifies the assigned
 * owner's reporting manager via the INTERNAL AdminNotificationService. Fires on
 * BOTH the normal pending path AND the auto-approved path (lost.approvalRequired
 * off). Best-effort: no-ops cleanly when the owner has no manager, and the
 * state-machine output is unchanged.
 *
 *   node tests/fix3-disqualify-notify.test.js
 *
 * Seeds isolated, uniquely-tagged docs against the local CRM DB; cleans up in
 * finally and restores the lost.approvalRequired setting.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const AdminNotification = require("../models/AdminNotification");
const SettingsService = require("../services/SettingsService");
const EnquiryService = require("../services/EnquiryService");

const TAG = `fix3-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const makeAdmin = (suffix, extra = {}) =>
  Admin.create({
    name: `${TAG}-${suffix}`, email: `${TAG}-${suffix}@x.com`, phone: `${TAG}${suffix}`,
    password: "x", roles: ["sales"], status: "active", ...extra,
  });

const makeOpenLead = (suffix, { assignedTo }) =>
  Enquiry.create({
    name: "Test Couple", phone: `${TAG}-${suffix}`, verified: false, isInterested: false,
    isLost: false, stage: "meeting_scheduled", source: "Default", lostStatus: "none",
    assignedTo,
  });

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  const approvalSnapshot = await SettingsService.get("lost.approvalRequired"); // restore later

  const adminIds = [], leadIds = [];
  try {
    const rep = await makeAdmin("rep");
    const manager = await makeAdmin("manager");
    rep.reportingManagerId = manager._id; await rep.save();
    const orphanRep = await makeAdmin("orphan"); // no reportingManagerId
    adminIds.push(rep._id, manager._id, orphanRep._id);

    // ── Case 1: normal pending path → manager notified, state machine unchanged.
    console.log("Case 1: requestDisqualification (approval ON) notifies the manager");
    await SettingsService.set("lost.approvalRequired", true);
    const l1 = await makeOpenLead("c1", { assignedTo: rep._id });
    leadIds.push(l1._id);
    const r1 = await EnquiryService.requestDisqualification(
      l1._id, { reason: "budget", note: "too low" }, rep._id
    );
    // State machine output unchanged:
    ok(r1.lostStatus === "pending", "lostStatus → pending (unchanged)");
    ok(r1.lostReason === "budget", "lostReason captured");
    ok(String(r1.lostRequestedBy) === String(rep._id), "lostRequestedBy = actor");
    ok(r1.stage === "meeting_scheduled", "stage NOT moved to lost while pending");
    // Notification to the manager:
    const n1 = await AdminNotification.find({ adminId: manager._id, leadId: l1._id, type: "lead_disqualify_requested" }).lean();
    ok(n1.length === 1, "exactly one AdminNotification for the reporting manager");
    ok(n1.length === 1 && n1[0].title === `Disqualification requested: ${l1.name}`, "title names the lead");
    ok(n1.length === 1 && n1[0].message === "budget", "message = reason");
    ok(n1.length === 1 && String(n1[0].leadId) === String(l1._id), "leadId set correctly");
    ok(n1.length === 1 && String(n1[0].payload.requestedBy) === String(rep._id), "payload.requestedBy = actor");
    // No notification leaked to the rep themselves:
    const n1self = await AdminNotification.find({ adminId: rep._id, leadId: l1._id }).lean();
    ok(n1self.length === 0, "requesting rep is NOT notified");

    // ── Case 2: auto-approved path (approval OFF) → manager still notified.
    console.log("Case 2: requestDisqualification (approval OFF) auto-approves AND notifies");
    await SettingsService.set("lost.approvalRequired", false);
    const l2 = await makeOpenLead("c2", { assignedTo: rep._id });
    leadIds.push(l2._id);
    const r2 = await EnquiryService.requestDisqualification(
      l2._id, { reason: "competitor" }, rep._id
    );
    ok(r2.lostStatus === "approved", "lostStatus → approved (auto-approve unchanged)");
    ok(r2.stage === "lost", "stage moved to lost (auto-approve unchanged)");
    const n2 = await AdminNotification.find({ adminId: manager._id, leadId: l2._id, type: "lead_disqualified" }).lean();
    ok(n2.length === 1, "manager notified on the auto-approved path");
    ok(n2.length === 1 && n2[0].title === `Lead disqualified: ${l2.name}`, "auto-approve title names the lead");

    // ── Case 3: owner has no manager → clean no-op (no notification, no throw).
    console.log("Case 3: owner without a reporting manager → no notification, no throw");
    await SettingsService.set("lost.approvalRequired", true);
    const l3 = await makeOpenLead("c3", { assignedTo: orphanRep._id });
    leadIds.push(l3._id);
    const r3 = await EnquiryService.requestDisqualification(
      l3._id, { reason: "not_a_fit" }, orphanRep._id
    );
    ok(r3.lostStatus === "pending", "state machine still advances to pending");
    const n3 = await AdminNotification.find({ leadId: l3._id }).lean();
    ok(n3.length === 0, "no AdminNotification created when owner has no manager");

    // ── Case 4: unassigned lead → clean no-op (no recipient to resolve).
    console.log("Case 4: unassigned lead → no notification, no throw");
    const l4 = await makeOpenLead("c4", { assignedTo: null });
    leadIds.push(l4._id);
    const r4 = await EnquiryService.requestDisqualification(
      l4._id, { reason: "other" }, rep._id
    );
    ok(r4.lostStatus === "pending", "unassigned lead still advances to pending");
    const n4 = await AdminNotification.find({ leadId: l4._id }).lean();
    ok(n4.length === 0, "no AdminNotification for an unassigned lead");

    // ── Case 5: decideDisqualification APPROVE → original requester notified.
    console.log("Case 5: decideDisqualification approve notifies the requester");
    await SettingsService.set("lost.approvalRequired", true);
    const l5 = await makeOpenLead("c5", { assignedTo: rep._id });
    leadIds.push(l5._id);
    await EnquiryService.requestDisqualification(l5._id, { reason: "budget" }, rep._id);
    // canApprove is computed by the controller; pass true to exercise the service path.
    const r5 = await EnquiryService.decideDisqualification(
      l5._id, { decision: "approve", note: "agreed" }, manager._id, true
    );
    // State machine output unchanged:
    ok(r5.lostStatus === "approved", "lostStatus → approved (unchanged)");
    ok(r5.stage === "lost", "stage moved to lost (unchanged)");
    ok(String(r5.lostDecidedBy) === String(manager._id), "lostDecidedBy = decider");
    // Notify-back to the requester (lostRequestedBy = rep):
    const n5 = await AdminNotification.find({ adminId: rep._id, leadId: l5._id, type: "lead_disqualify_approved" }).lean();
    ok(n5.length === 1, "exactly one approve notification for the requester");
    ok(n5.length === 1 && n5[0].title === `Disqualification approved: ${l5.name}`, "approve title names the lead");
    ok(n5.length === 1 && n5[0].message === "agreed", "approve message = decision note");
    ok(n5.length === 1 && String(n5[0].leadId) === String(l5._id), "approve leadId correct");
    ok(n5.length === 1 && String(n5[0].payload.decidedBy) === String(manager._id), "payload.decidedBy = decider");

    // ── Case 6: decideDisqualification REJECT → original requester notified.
    console.log("Case 6: decideDisqualification reject notifies the requester");
    const l6 = await makeOpenLead("c6", { assignedTo: rep._id });
    leadIds.push(l6._id);
    await EnquiryService.requestDisqualification(l6._id, { reason: "competitor" }, rep._id);
    const r6 = await EnquiryService.decideDisqualification(
      l6._id, { decision: "reject", note: "keep working it" }, manager._id, true
    );
    ok(r6.lostStatus === "rejected", "lostStatus → rejected (unchanged)");
    ok(r6.stage === "meeting_scheduled", "stage restored to stageBeforeLost (unchanged)");
    const n6 = await AdminNotification.find({ adminId: rep._id, leadId: l6._id, type: "lead_disqualify_rejected" }).lean();
    ok(n6.length === 1, "exactly one reject notification for the requester");
    ok(n6.length === 1 && n6[0].title === `Disqualification rejected: ${l6.name}`, "reject title names the lead");
    ok(n6.length === 1 && String(n6[0].leadId) === String(l6._id), "reject leadId correct");

    // ── Case 7: decision with no lostRequestedBy → clean no-op (no notify, no throw).
    console.log("Case 7: decision with absent requester → no notify-back, no throw");
    const l7 = await makeOpenLead("c7", { assignedTo: orphanRep._id });
    leadIds.push(l7._id);
    // actorId null on the request → lostRequestedBy stays null.
    await EnquiryService.requestDisqualification(l7._id, { reason: "not_a_fit" }, null);
    const r7 = await EnquiryService.decideDisqualification(
      l7._id, { decision: "approve", note: "" }, manager._id, true
    );
    ok(r7.lostStatus === "approved", "state machine still advances to approved");
    const n7 = await AdminNotification.find({ leadId: l7._id, type: { $in: ["lead_disqualify_approved", "lead_disqualify_rejected"] } }).lean();
    ok(n7.length === 0, "no decision notify-back when lostRequestedBy is absent");
  } finally {
    if (leadIds.length) {
      await AdminNotification.deleteMany({ leadId: { $in: leadIds } });
      await Enquiry.deleteMany({ _id: { $in: leadIds } });
    }
    if (adminIds.length) await Admin.deleteMany({ _id: { $in: adminIds } });
    await SettingsService.set("lost.approvalRequired", approvalSnapshot); // restore
    await mongoose.disconnect();
  }

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("Test harness error:", e); process.exit(1); });
