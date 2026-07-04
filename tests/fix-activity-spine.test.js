/**
 * Signal spine write paths — Signal Matrix Slice 4 (NO read changes yet).
 *
 * Two denormalized Enquiry fields:
 *   firstRespondedAt — set-once, first CUSTOMER-FACING response on any channel
 *                      (call, WhatsApp press/send, timestamped note). Never
 *                      tasks/chat.
 *   lastActivityAt   — monotonic ($max), ANY employee action.
 *
 *   node tests/fix-activity-spine.test.js
 *
 * Seeds isolated, uniquely-tagged docs against the local CRM DB; cleans up in
 * finally.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Department = require("../models/Department");
const LeadTask = require("../models/LeadTask");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const LeadChatMessage = require("../models/LeadChatMessage");
const AdminNotification = require("../models/AdminNotification");
const CallCockpitService = require("../services/CallCockpitService");
const LeadTaskService = require("../services/LeadTaskService");
const EnquiryRepository = require("../repositories/EnquiryRepository");

const TAG = `spine-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const makeLead = (suffix) =>
  Enquiry.create({
    name: `Spine Lead ${suffix}`, phone: `${TAG}-${suffix}`, verified: false,
    isInterested: false, isLost: false, stage: "new", source: "Default",
  });

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

    // ── 1. Call → response AND activity.
    console.log("1. logCall stamps both spine fields");
    const l1 = await makeLead("call");
    leadIds.push(l1._id);
    const callStart = new Date(Date.now() - 5 * 60 * 1000);
    await CallCockpitService.logCall(
      l1._id,
      { startedAt: callStart.toISOString(), durationSeconds: 60, connected: true, outcome: "", notes: "" },
      actor._id
    );
    let s1 = await Enquiry.findById(l1._id).lean();
    ok(s1.firstRespondedAt != null, "firstRespondedAt set by a call");
    ok(+new Date(s1.firstRespondedAt) === +callStart, "firstRespondedAt = the call's startedAt");
    ok(s1.lastActivityAt != null, "lastActivityAt set by a call");

    // Set-once: a later call must not move firstRespondedAt.
    await CallCockpitService.logCall(
      l1._id,
      { startedAt: new Date().toISOString(), durationSeconds: 30, connected: false, outcome: "busy", notes: "" },
      actor._id
    );
    const s1b = await Enquiry.findById(l1._id).lean();
    ok(+new Date(s1b.firstRespondedAt) === +callStart, "firstRespondedAt is set-once (second call ignored)");
    ok(+new Date(s1b.lastActivityAt) >= +new Date(s1.lastActivityAt), "lastActivityAt only moves forward");

    // ── 2. WhatsApp press → response WITHOUT satisfying the call-only TAT.
    console.log("2. logWhatsappActivity stamps the spine, never firstCalledAt");
    const l2 = await makeLead("wa");
    leadIds.push(l2._id);
    await CallCockpitService.logWhatsappActivity(l2._id, { message: "hi!" }, actor._id);
    const s2 = await Enquiry.findById(l2._id).lean();
    ok(s2.firstRespondedAt != null, "firstRespondedAt set by the WhatsApp press");
    ok(s2.lastActivityAt != null, "lastActivityAt set by the WhatsApp press");
    ok(s2.firstCalledAt == null, "firstCalledAt STILL null (call-only TAT untouched)");
    ok((s2.callLog || []).length === 0, "no callLog entry");

    // ── 3. Task → activity only, never a response.
    console.log("3. tasks touch lastActivityAt but never firstRespondedAt");
    const l3 = await makeLead("task");
    leadIds.push(l3._id);
    await LeadTaskService.createTask(
      l3._id,
      { title: "Prep the venue shortlist", assigneeId: actor._id, dueAt: new Date(Date.now() + 86400000).toISOString() },
      actor._id
    );
    const s3 = await Enquiry.findById(l3._id).lean();
    ok(s3.lastActivityAt != null, "lastActivityAt set by task creation");
    ok(s3.firstRespondedAt == null, "firstRespondedAt NOT set by a task (internal ≠ response)");

    // ── 4. Cockpit follow-up → activity only.
    console.log("4. addFollowUp touches lastActivityAt only");
    const l4 = await makeLead("fu");
    leadIds.push(l4._id);
    await CallCockpitService.addFollowUp(
      l4._id,
      { type: "call", scheduledAt: new Date(Date.now() + 86400000).toISOString() },
      actor._id
    );
    const s4 = await Enquiry.findById(l4._id).lean();
    ok(s4.lastActivityAt != null, "lastActivityAt set by scheduling a follow-up");
    ok(s4.firstRespondedAt == null, "firstRespondedAt NOT set by scheduling");

    // ── 5. $max semantics: touch never moves the clock backwards.
    console.log("5. touchLastActivity is monotonic");
    const past = new Date(Date.now() - 3600 * 1000);
    await EnquiryRepository.touchLastActivity(l4._id, past);
    const s5 = await Enquiry.findById(l4._id).lean();
    ok(+new Date(s5.lastActivityAt) === +new Date(s4.lastActivityAt), "an older stamp does not lower lastActivityAt");

    // ── 6. Slice 4 contract: reads unchanged — the respond-now filter field
    //      (firstCalledAt) is untouched by non-call actions above.
    ok(s2.firstCalledAt == null && s3.firstCalledAt == null && s4.firstCalledAt == null,
      "no non-call path stamped firstCalledAt (read criteria untouched until Slice 5)");
  } finally {
    if (leadIds.length) {
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
