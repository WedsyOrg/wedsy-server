/**
 * Deal spine + proposal signal — Slice B2.
 *
 * computeDealSpine derives six stations (qualified → meeting_set →
 * meeting_held → proposal → agreement → onboarded) purely from existing state
 * objects; POST /enquiry/:_id/proposal-sent is the one new (set-once) signal.
 *
 *   node tests/deal-spine.test.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Department = require("../models/Department");
const CalendarEvent = require("../models/CalendarEvent");
const Onboarding = require("../models/Onboarding");
const Project = require("../models/Project");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const LeadTeamMember = require("../models/LeadTeamMember");
const LeadStep = require("../models/LeadStep");
const AdminNotification = require("../models/AdminNotification");
const LeadLifecycleService = require("../services/LeadLifecycleService");
const CallCockpitService = require("../services/CallCockpitService");
const DealSpineService = require("../services/DealSpineService");
const enquiry = require("../controllers/enquiry");

const TAG = `spinez-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const spineNow = async (leadId) => {
  const lead = await Enquiry.findById(leadId).lean();
  return DealSpineService.computeDealSpine(lead, await DealSpineService.spineInputs(leadId));
};
const station = (spine, key) => spine.stations.find((s) => s.key === key);

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
    const owner = await Admin.create({
      name: `${TAG}-owner`, email: `${TAG}@x.com`, phone: `${TAG}a`,
      password: "x", status: "active", departmentId: dept._id,
    });
    adminIds.push(owner._id);
    const lead = await Enquiry.create({
      name: "Spine Lead", phone: `${TAG}`, verified: false, isInterested: false,
      isLost: false, stage: "contacted", source: "Default", assignedTo: owner._id,
    });
    leadIds.push(lead._id);

    // ── Station-by-station flips.
    console.log("1. spine flips station by station");
    let sp = await spineNow(lead._id);
    ok(sp.stations.length === 6, "six stations");
    ok(sp.current === "qualified" && station(sp, "qualified").current === true, "fresh lead → current = qualified");

    await LeadLifecycleService.qualifyLead(lead._id, owner._id);
    sp = await spineNow(lead._id);
    ok(station(sp, "qualified").done === true && station(sp, "qualified").at != null, "qualify → qualified done + at");
    ok(sp.current === "meeting_set", "current advanced to meeting_set");

    const meetAt = new Date(Date.now() + 2 * 86400000);
    await CallCockpitService.addFollowUp(lead._id, { type: "meet", scheduledAt: meetAt.toISOString() }, owner._id);
    sp = await spineNow(lead._id);
    ok(station(sp, "meeting_set").done === true && +new Date(station(sp, "meeting_set").at) === +meetAt,
      "meet booked → meeting_set done, at = earliest meet scheduledAt");
    ok(sp.current === "meeting_held", "current = meeting_held");

    const closedAt = new Date();
    await CalendarEvent.create({
      ownerId: owner._id, type: "gmeet", leadId: lead._id, title: "G-Meet — Spine Lead",
      start: new Date(Date.now() - 3600000), end: new Date(), status: "closed",
      notes: "went well", closedAt, closedBy: owner._id,
    });
    sp = await spineNow(lead._id);
    ok(station(sp, "meeting_held").done === true, "closed calendar meet → meeting_held done");
    ok(sp.current === "proposal", "current = proposal");

    // ── Proposal endpoint: set-once + event + activity stamp.
    console.log("2. proposal-sent set-once");
    const before = await Enquiry.findById(lead._id).lean();
    await LeadLifecycleService.markProposalSent(lead._id, { amount: 350000 }, owner._id);
    const after = await Enquiry.findById(lead._id).lean();
    ok(after.proposalSentAt != null && after.proposalAmount === 350000, "proposalSentAt + amount persisted");
    ok(+new Date(after.lastActivityAt) >= +new Date(before.lastActivityAt || 0), "lastActivityAt stamped");
    const evs = await LeadInternalEvent.find({ leadId: lead._id, type: "proposal_sent" }).lean();
    ok(evs.length === 1 && evs[0].payload.amount === 350000, "one proposal_sent event with amount");
    let dup = null;
    try { await LeadLifecycleService.markProposalSent(lead._id, {}, owner._id); } catch (e) { dup = e.status; }
    ok(dup === 409, `second proposal-sent → 409 (got ${dup})`);
    sp = await spineNow(lead._id);
    ok(station(sp, "proposal").done === true && sp.current === "agreement", "proposal done → current = agreement");

    await Onboarding.create({ leadId: lead._id, agreement: { accepted: true, acceptedAt: new Date() } });
    sp = await spineNow(lead._id);
    ok(station(sp, "agreement").done === true && sp.current === "onboarded", "agreement accepted → current = onboarded");

    await Project.create({ leadId: lead._id, coupleNames: "Spine Lead" });
    sp = await spineNow(lead._id);
    ok(station(sp, "onboarded").done === true && sp.current === null, "project → onboarded done, no current station");

    // ── daysInStation math.
    console.log("3. current-station clock");
    const lead2 = await Enquiry.create({
      name: "Clock Lead", phone: `${TAG}-2`, verified: false, isInterested: false,
      isLost: false, stage: "contacted", source: "Default", assignedTo: owner._id,
      qualified: true, qualifiedAt: new Date(Date.now() - 5 * 86400000),
    });
    leadIds.push(lead2._id);
    const sp2 = await spineNow(lead2._id);
    const cur2 = station(sp2, "meeting_set");
    ok(sp2.current === "meeting_set" && cur2.current === true, "5d-old qualified lead → current = meeting_set");
    ok(cur2.sinceDays === 5 && cur2.sinceLabel === "5d", `clock anchored on qualifiedAt (got ${cur2.sinceDays}/${cur2.sinceLabel})`);

    // ── GET decoration.
    console.log("4. single-lead GET carries dealSpine");
    const r = await run(enquiry.Get, {
      params: { _id: String(lead._id) }, query: {},
      scopeFilter: { assignedTo: owner._id }, auth: { user_id: String(owner._id) },
    });
    ok(r.status === 200 && r.body.dealSpine && r.body.dealSpine.stations.length === 6, "GET decorated with dealSpine");
    ok(r.body.dealSpine.current === null, "decorated spine agrees (fully converted lead)");
  } finally {
    if (leadIds.length) {
      await CalendarEvent.deleteMany({ leadId: { $in: leadIds } });
      await Onboarding.deleteMany({ leadId: { $in: leadIds } });
      await Project.deleteMany({ leadId: { $in: leadIds } });
      await LeadInternalEvent.deleteMany({ leadId: { $in: leadIds } });
      await LeadTeamMember.deleteMany({ leadId: { $in: leadIds } });
      await LeadStep.deleteMany({ leadId: { $in: leadIds } });
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
