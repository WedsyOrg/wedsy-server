/**
 * NEW-LEAD NOTIFICATION — internal OS notification fired when a lead is created.
 *
 * Service (LeadIntakeService.afterCreate): ADDITIVE only — after assignment
 * resolves (LeadAssignmentService.assignLead returns), it notifies via the
 * INTERNAL AdminNotificationService:
 *   - assignee came back        → ping that assignee's _id        (payload.assigned=true)
 *   - null (triage / disabled)  → ping TriageService.triageHolderIds()  (assigned=false)
 * Fires ONCE per lead. Best-effort: a throwing notify must NEVER break the
 * create path (afterCreate resolves cleanly and the lead survives).
 *
 *   node tests/new-lead-notify.test.js
 *
 * Collaborators (assignLead, triageHolderIds, the Kiara safety net) are stubbed
 * so the assigned-vs-unassigned outcome is deterministic and no Settings/pool
 * fixtures are needed. Seeds isolated, uniquely-tagged docs; cleans up in finally.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const AdminNotification = require("../models/AdminNotification");

// Pull the SAME cached module objects LeadIntakeService holds references to, so
// reassigning a method here swaps the implementation the service actually calls.
const LeadAssignmentService = require("../services/LeadAssignmentService");
const TriageService = require("../services/TriageService");
const AdminNotificationService = require("../services/AdminNotificationService");
const KiaraSafetyNetService = require("../services/KiaraSafetyNetService");
const LeadIntakeService = require("../services/LeadIntakeService");

const TAG = `newlead-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const oid = () => new mongoose.Types.ObjectId();

const makeLead = (suffix, { source } = {}) =>
  Enquiry.create({
    name: `Test Couple ${suffix}`, phone: `${TAG}-${suffix}`, verified: false,
    isInterested: false, isLost: false, stage: "new", source: source || "Default",
  });

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

  // Snapshot originals; the Kiara safety net is stubbed to a no-op throughout so
  // afterCreate's third step never touches Settings/templates.
  const orig = {
    assignLead: LeadAssignmentService.assignLead,
    triageHolderIds: TriageService.triageHolderIds,
    notify: AdminNotificationService.notify,
    safetyNet: KiaraSafetyNetService.maybeEngageOnCreate,
  };
  KiaraSafetyNetService.maybeEngageOnCreate = async () => {};

  const leadIds = [];
  try {
    // ── Case 1: assigned → the assignee (and only them) is notified. ──────────
    console.log("Case 1: assigned lead → assignee notified, payload.assigned=true");
    const assigneeId = oid();
    LeadAssignmentService.assignLead = async () => ({ _id: assigneeId, name: "Intern A" });
    // Triage resolver should NOT be consulted on the assigned path — make it throw
    // so the test fails loudly if the branch is wrong.
    TriageService.triageHolderIds = async () => { throw new Error("triageHolderIds must not run on the assigned path"); };
    AdminNotificationService.notify = orig.notify;
    const l1 = await makeLead("c1", { source: "facebook_june_decor" });
    leadIds.push(l1._id);
    await LeadIntakeService.afterCreate(l1._id);
    const n1 = await AdminNotification.find({ leadId: l1._id }).lean();
    ok(n1.length === 1, "exactly one AdminNotification created");
    ok(n1.length === 1 && String(n1[0].adminId) === String(assigneeId), "addressed to the assignee _id");
    ok(n1.length === 1 && n1[0].type === "new_lead", "type = new_lead");
    ok(n1.length === 1 && n1[0].title === `New lead: ${l1.name}`, "title names the lead");
    ok(n1.length === 1 && n1[0].payload.assigned === true, "payload.assigned = true");
    ok(n1.length === 1 && n1[0].payload.source === "facebook_june_decor", "payload.source carried");
    ok(n1.length === 1 && String(n1[0].leadId) === String(l1._id), "leadId set correctly");
    ok(n1.length === 1 && n1[0].message.includes("facebook_june_decor"), "message carries the source");

    // ── Case 2: unassigned (triage) → all triage holders notified. ────────────
    console.log("Case 2: unassigned lead → triage holders notified, payload.assigned=false");
    const holderA = oid(), holderB = oid();
    LeadAssignmentService.assignLead = async () => null; // triage / disabled / no capacity
    TriageService.triageHolderIds = async () => [holderA, holderB];
    AdminNotificationService.notify = orig.notify;
    const l2 = await makeLead("c2", { source: "instagram" });
    leadIds.push(l2._id);
    await LeadIntakeService.afterCreate(l2._id);
    const n2 = await AdminNotification.find({ leadId: l2._id }).lean();
    ok(n2.length === 2, "one AdminNotification per triage holder (2)");
    const recipients = n2.map((n) => String(n.adminId)).sort();
    ok(JSON.stringify(recipients) === JSON.stringify([holderA, holderB].map(String).sort()), "addressed to exactly the triage holders");
    ok(n2.every((n) => n.type === "new_lead"), "type = new_lead");
    ok(n2.every((n) => n.payload.assigned === false), "payload.assigned = false");
    ok(n2.every((n) => n.message.includes("triage")), "message uses triage framing");

    // ── Case 2b: unassigned with NO triage holders → clean no-op. ─────────────
    console.log("Case 2b: unassigned + no triage holders → no notification, no throw");
    LeadAssignmentService.assignLead = async () => null;
    TriageService.triageHolderIds = async () => [];
    const l2b = await makeLead("c2b");
    leadIds.push(l2b._id);
    let threw2b = false;
    try { await LeadIntakeService.afterCreate(l2b._id); } catch (_) { threw2b = true; }
    ok(!threw2b, "afterCreate did not throw");
    const n2b = await AdminNotification.find({ leadId: l2b._id }).lean();
    ok(n2b.length === 0, "no AdminNotification when there are no triage holders");

    // ── Case 3: notify THROWS → creation path is not broken. ───────────────────
    console.log("Case 3: a throwing notify does NOT break lead creation");
    LeadAssignmentService.assignLead = async () => ({ _id: oid(), name: "Intern B" });
    TriageService.triageHolderIds = async () => [oid()];
    AdminNotificationService.notify = async () => { throw new Error("simulated notify failure"); };
    const l3 = await makeLead("c3");
    leadIds.push(l3._id);
    let threw3 = false;
    try { await LeadIntakeService.afterCreate(l3._id); } catch (_) { threw3 = true; }
    ok(!threw3, "afterCreate resolved cleanly despite notify throwing");
    const stillThere = await Enquiry.findById(l3._id).lean();
    ok(!!stillThere, "the created lead still exists (creation not rolled back)");
    const n3 = await AdminNotification.find({ leadId: l3._id }).lean();
    ok(n3.length === 0, "no notification persisted when notify throws");

    // ── Case 4: fires exactly ONCE per afterCreate (no duplication). ──────────
    console.log("Case 4: exactly one notify per afterCreate call (assigned path)");
    const solo = oid();
    LeadAssignmentService.assignLead = async () => ({ _id: solo, name: "Intern C" });
    TriageService.triageHolderIds = async () => { throw new Error("should not run"); };
    AdminNotificationService.notify = orig.notify;
    const l4 = await makeLead("c4");
    leadIds.push(l4._id);
    await LeadIntakeService.afterCreate(l4._id);
    const n4 = await AdminNotification.find({ leadId: l4._id }).lean();
    ok(n4.length === 1, "exactly one notification row for one afterCreate call");
  } finally {
    // Restore the patched collaborators.
    LeadAssignmentService.assignLead = orig.assignLead;
    TriageService.triageHolderIds = orig.triageHolderIds;
    AdminNotificationService.notify = orig.notify;
    KiaraSafetyNetService.maybeEngageOnCreate = orig.safetyNet;
    if (leadIds.length) {
      await AdminNotification.deleteMany({ leadId: { $in: leadIds } });
      await Enquiry.deleteMany({ _id: { $in: leadIds } });
    }
    await mongoose.disconnect();
  }

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("Test harness error:", e); process.exit(1); });
