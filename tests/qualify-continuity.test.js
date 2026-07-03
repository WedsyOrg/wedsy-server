/**
 * Qualify continuity — Slice B1.
 *
 * 1. Detail-GET + every lead-page READ route honour CURRENT roster membership
 *    (the qualify handoff moved assignedTo to the manager; the qualifying rep
 *    stays able to READ). Writes keep their strict owner/manager scope.
 * 2. The auto-roster row carries role: "qualifier".
 * 3. The new owner gets ONE lead_qualified_handoff AdminNotification.
 *
 *   node tests/qualify-continuity.test.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Department = require("../models/Department");
const LeadTeamMember = require("../models/LeadTeamMember");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const AdminNotification = require("../models/AdminNotification");
const LeadStep = require("../models/LeadStep");
const LeadChatMessage = require("../models/LeadChatMessage");
const LeadLifecycleService = require("../services/LeadLifecycleService");
const enquiry = require("../controllers/enquiry");
const followup = require("../controllers/followup");
const accountability = require("../controllers/accountability");
const leadStep = require("../controllers/leadStep");
const leadChat = require("../controllers/leadChat");
const leadTask = require("../controllers/leadTask");

const TAG = `qcont-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const run = (handler, req) =>
  new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      send(b) { resolve({ status: this.statusCode, body: b }); },
      json(b) { resolve({ status: this.statusCode, body: b }); },
    };
    handler(req, res);
  });

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

  const leadIds = [], adminIds = [];
  let dept = null;
  try {
    dept = await Department.create({ name: `${TAG}-dept` });
    const manager = await Admin.create({
      name: `${TAG}-manager`, email: `${TAG}-mgr@x.com`, phone: `${TAG}m`,
      password: "x", status: "active", departmentId: dept._id,
    });
    const intern = await Admin.create({
      name: `${TAG}-intern`, email: `${TAG}-int@x.com`, phone: `${TAG}i`,
      password: "x", status: "active", departmentId: dept._id,
      reportingManagerId: manager._id,
    });
    const outsider = await Admin.create({
      name: `${TAG}-outsider`, email: `${TAG}-out@x.com`, phone: `${TAG}o`,
      password: "x", status: "active", departmentId: dept._id,
    });
    adminIds.push(manager._id, intern._id, outsider._id);

    const lead = await Enquiry.create({
      name: "Continuity Lead", phone: `${TAG}`, verified: false, isInterested: false,
      isLost: false, stage: "contacted", source: "Default", assignedTo: intern._id,
    });
    leadIds.push(lead._id);

    // ── Qualify: handoff + roster role + notification.
    console.log("1. qualify → roster role + handoff notification");
    const q = await LeadLifecycleService.qualifyLead(lead._id, intern._id);
    ok(q.handedOff === true, "handoff fired");
    const row = await LeadTeamMember.findOne({ leadId: lead._id, personId: intern._id, activeTo: null }).lean();
    ok(!!row && row.role === "qualifier", 'roster row carries role "qualifier"');

    const notifs = await AdminNotification.find({ adminId: manager._id, leadId: lead._id, type: "lead_qualified_handoff" }).lean();
    ok(notifs.length === 1, "new owner got exactly ONE lead_qualified_handoff notification");
    ok(notifs[0] && String(notifs[0].payload.qualifiedBy) === String(intern._id), "payload.qualifiedBy = the qualifier");

    // Idempotent: re-qualify → no second notification, no duplicate roster row.
    await LeadLifecycleService.qualifyLead(lead._id, intern._id);
    ok((await AdminNotification.countDocuments({ adminId: manager._id, leadId: lead._id, type: "lead_qualified_handoff" })) === 1,
      "re-qualify does NOT re-notify");

    // ── Roster member READS (intern, own scope — lead now the manager's).
    console.log("2. roster member can READ the lead page routes");
    const internReq = (extra = {}) => ({
      params: { _id: String(lead._id) },
      query: {},
      scopeFilter: { assignedTo: intern._id },
      auth: { user_id: String(intern._id) },
      ...extra,
    });
    const rGet = await run(enquiry.Get, internReq());
    ok(rGet.status === 200 && String(rGet.body._id) === String(lead._id), `detail GET readable (got ${rGet.status})`);
    ok(rGet.body.discovery && rGet.body.lifecycle !== undefined, "detail GET still fully decorated");
    const rFu = await run(followup.ListForLead, internReq());
    ok(rFu.status === 200, `followups list readable (got ${rFu.status})`);
    const rAcc = await run(accountability.Assess, internReq());
    ok(rAcc.status === 200, `accountability readable (got ${rAcc.status})`);
    const rSteps = await run(leadStep.List, internReq());
    ok(rSteps.status === 200, `steps list readable (got ${rSteps.status})`);
    const rChat = await run(leadChat.List, internReq());
    ok(rChat.status === 200, `chat list readable (got ${rChat.status})`);
    const rMembers = await run(leadChat.Members, internReq());
    ok(rMembers.status === 200, `chat members readable (got ${rMembers.status})`);
    const rTasks = await run(leadTask.ListForLead, internReq({ query: { leadId: String(lead._id) } }));
    ok(rTasks.status === 200, `lead-tasks list readable (got ${rTasks.status})`);

    // ── Non-member stays locked out.
    console.log("3. non-member unchanged");
    const outReq = (extra = {}) => ({
      params: { _id: String(lead._id) },
      query: {},
      scopeFilter: { assignedTo: outsider._id },
      auth: { user_id: String(outsider._id) },
      ...extra,
    });
    ok((await run(enquiry.Get, outReq())).status === 404, "outsider detail GET → 404");
    ok((await run(followup.ListForLead, outReq())).status === 403, "outsider followups → 403");
    ok((await run(leadStep.List, outReq())).status === 403, "outsider steps → 403");
    ok((await run(leadChat.List, outReq())).status === 403, "outsider chat → 403");

    // ── Writes unchanged: the intern's WRITE routes still use the strict scope.
    console.log("4. writes keep the strict owner scope");
    const rWrite = await run(followup.Create, internReq({ body: { title: "x", dueAt: new Date().toISOString() } }));
    ok(rWrite.status === 403, `followup CREATE still 403 for the roster member (got ${rWrite.status})`);
  } finally {
    if (leadIds.length) {
      await LeadTeamMember.deleteMany({ leadId: { $in: leadIds } });
      await LeadInternalEvent.deleteMany({ leadId: { $in: leadIds } });
      await AdminNotification.deleteMany({ leadId: { $in: leadIds } });
      await LeadStep.deleteMany({ leadId: { $in: leadIds } });
      await LeadChatMessage.deleteMany({ leadId: { $in: leadIds } });
      await Enquiry.deleteMany({ _id: { $in: leadIds } });
    }
    if (adminIds.length) await Admin.deleteMany({ _id: { $in: adminIds } });
    if (dept) await Department.deleteMany({ _id: dept._id });
    await mongoose.disconnect();
  }

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("Test harness error:", e); process.exit(1); });
