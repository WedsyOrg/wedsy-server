/**
 * #8 — Unqualify a lead.
 *
 * Service (LeadLifecycleService.unqualifyLead): reverts qualified/qualifiedAt/
 * qualifiedBy, returns ownership to the intern, tags "Unqualified", records an
 * "unqualified" event, notifies the intern internally — without touching
 * discovery data. Controller (lifecycle.Unqualify): eligibility EXACTLY like
 * disqualify-decision (leads:approve OR assignee's manager); interns get 403.
 *
 *   node tests/fix8-unqualify.test.js
 *
 * Seeds isolated, uniquely-tagged docs against the local CRM DB; cleans up in
 * finally and restores the tags.available setting.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const AdminNotification = require("../models/AdminNotification");
const SettingsService = require("../services/SettingsService");
const LeadLifecycleService = require("../services/LeadLifecycleService");
const lifecycle = require("../controllers/enquiry-lifecycle");

const TAG = `fix8-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const mockRes = () => {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
};

const makeAdmin = (suffix, extra = {}) =>
  Admin.create({
    name: `${TAG}-${suffix}`, email: `${TAG}-${suffix}@x.com`, phone: `${TAG}${suffix}`,
    password: "x", roles: ["sales"], status: "active", ...extra,
  });

const makeQualifiedLead = (suffix, { assignedTo, qualifiedBy }) =>
  Enquiry.create({
    name: "Test Couple", phone: `${TAG}-${suffix}`, verified: false, isInterested: false,
    isLost: false, stage: "meeting_scheduled", source: "Default",
    qualified: true, qualifiedAt: new Date(), qualifiedBy, assignedTo,
    qualificationData: { groomName: "Aarav", brideName: "Asha" },
    qualifierNotes: "discovery: Dec wedding, Bangalore",
    tags: [],
  });

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  const tagsSnapshot = await SettingsService.get("tags.available"); // restore later

  const adminIds = [], leadIds = [], roleIds = [];
  try {
    const intern = await makeAdmin("intern");
    const manager = await makeAdmin("manager");
    intern.reportingManagerId = manager._id; await intern.save();
    const approver = await makeAdmin("approver");
    const role = await Role.create({ name: `${TAG}-RevHead`, departmentId: new mongoose.Types.ObjectId(), permissions: ["leads:approve:all"] });
    approver.roleIds = [role._id]; await approver.save();
    adminIds.push(intern._id, manager._id, approver._id); roleIds.push(role._id);

    // ── Case 1: SERVICE — qualified, handed-off lead → unqualify reverts fully.
    console.log("Case 1: unqualifyLead reverts a handed-off qualified lead");
    const l1 = await makeQualifiedLead("c1", { assignedTo: manager._id, qualifiedBy: intern._id });
    leadIds.push(l1._id);
    const r1 = await LeadLifecycleService.unqualifyLead(l1._id, approver._id, { reason: "Wrongly qualified — no budget" });
    ok(r1.qualified === false, "qualified=false");
    ok(r1.qualifiedAt == null && r1.qualifiedBy == null, "qualifiedAt & qualifiedBy cleared");
    ok(String(r1.assignedTo) === String(intern._id), "assignedTo returned to the intern (qualifiedBy)");
    ok((r1.tags || []).includes("Unqualified"), "'Unqualified' tag present on the lead");
    ok(r1.qualificationData.groomName === "Aarav" && r1.qualificationData.brideName === "Asha", "qualificationData unchanged");
    ok(r1.qualifierNotes === "discovery: Dec wedding, Bangalore", "qualifierNotes unchanged");
    ok(r1.name === "Test Couple", "name unchanged");
    const events1 = await LeadInternalEvent.find({ leadId: l1._id, type: "unqualified" }).lean();
    ok(events1.length === 1, "exactly one 'unqualified' LeadInternalEvent");
    ok(events1[0].payload && events1[0].payload.reason === "Wrongly qualified — no budget" &&
       String(events1[0].payload.previousOwner) === String(manager._id) &&
       String(events1[0].payload.returnedTo) === String(intern._id), "event payload has reason/previousOwner/returnedTo");
    const notifs1 = await AdminNotification.find({ adminId: intern._id, type: "lead_unqualified", leadId: l1._id }).lean();
    ok(notifs1.length === 1, "AdminNotification created for the intern");
    const lib = await SettingsService.get("tags.available");
    ok(lib.includes("Unqualified"), "'Unqualified' added to tags.available library");

    // ── Case 2: SERVICE — reason missing → 400, no mutation.
    console.log("Case 2: missing reason → 400, no mutation");
    const l2 = await makeQualifiedLead("c2", { assignedTo: manager._id, qualifiedBy: intern._id });
    leadIds.push(l2._id);
    let threw = null;
    try { await LeadLifecycleService.unqualifyLead(l2._id, approver._id, { reason: "   " }); }
    catch (e) { threw = e; }
    ok(threw && threw.status === 400, "throws 400 when reason blank/missing");
    const l2after = await Enquiry.findById(l2._id).lean();
    ok(l2after.qualified === true && !(l2after.tags || []).includes("Unqualified"), "no mutation on the lead");

    // ── Case 4: SERVICE — non-qualified lead → no-op.
    console.log("Case 4: non-qualified lead → no-op");
    const l4 = await Enquiry.create({ name: "Cold", phone: `${TAG}-c4`, verified: false, isInterested: false, isLost: false, stage: "new", source: "Default", qualified: false });
    leadIds.push(l4._id);
    const r4 = await LeadLifecycleService.unqualifyLead(l4._id, approver._id, { reason: "n/a" });
    ok(r4.qualified === false, "returns the lead unchanged");
    const ev4 = await LeadInternalEvent.find({ leadId: l4._id, type: "unqualified" }).lean();
    ok(ev4.length === 0 && !(r4.tags || []).includes("Unqualified"), "no event, no tag (true no-op)");

    // ── Case 3: CONTROLLER — intern (no approve, not manager) → 403, no mutation.
    console.log("Case 3: intern actor → 403");
    const l3 = await makeQualifiedLead("c3", { assignedTo: manager._id, qualifiedBy: intern._id });
    leadIds.push(l3._id);
    const res3 = mockRes();
    await lifecycle.Unqualify({ auth: { user_id: String(intern._id) }, params: { _id: String(l3._id) }, body: { reason: "x" } }, res3);
    ok(res3.statusCode === 403, "controller returns 403 for an intern");
    const l3after = await Enquiry.findById(l3._id).lean();
    ok(l3after.qualified === true, "lead still qualified (no mutation)");

    // ── Eligibility ALLOW (controller): manager-of-assignee passes.
    console.log("Eligibility: assignee's manager → allowed");
    const l5 = await makeQualifiedLead("c5", { assignedTo: intern._id, qualifiedBy: intern._id });
    leadIds.push(l5._id);
    const res5 = mockRes();
    await lifecycle.Unqualify({ auth: { user_id: String(manager._id) }, params: { _id: String(l5._id) }, body: { reason: "manager override" } }, res5);
    ok(res5.statusCode === 200 && res5.body.qualified === false, "manager passes the gate and unqualifies");

    // ── Eligibility ALLOW (controller): leads:approve holder (Sales Lead / Rev Head).
    console.log("Eligibility: leads:approve holder → allowed");
    const l6 = await makeQualifiedLead("c6", { assignedTo: manager._id, qualifiedBy: intern._id });
    leadIds.push(l6._id);
    const res6 = mockRes();
    await lifecycle.Unqualify({ auth: { user_id: String(approver._id) }, params: { _id: String(l6._id) }, body: { reason: "rev head call" } }, res6);
    ok(res6.statusCode === 200 && res6.body.qualified === false, "leads:approve holder passes the gate");
  } finally {
    if (leadIds.length) {
      await LeadInternalEvent.deleteMany({ leadId: { $in: leadIds } });
      await AdminNotification.deleteMany({ leadId: { $in: leadIds } });
      await Enquiry.deleteMany({ _id: { $in: leadIds } });
    }
    if (adminIds.length) await Admin.deleteMany({ _id: { $in: adminIds } });
    if (roleIds.length) await Role.deleteMany({ _id: { $in: roleIds } });
    await SettingsService.set("tags.available", tagsSnapshot); // restore the library
    await mongoose.disconnect();
  }

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("Test harness error:", e); process.exit(1); });
