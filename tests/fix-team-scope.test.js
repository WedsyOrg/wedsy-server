/**
 * Team scope + roster continuity — Signal Matrix Slice 3.
 *
 * The qualify handoff moves assignedTo to the reporting manager, which used to
 * lock the qualifying rep out of their own lead's team routes ("Out of your
 * scope" 403) and left roster members invisible in the normal lead list.
 * Now:
 *   1. qualifyLead auto-adds the pre-handoff owner to the roster (idempotent).
 *   2. leadTeam's scope guard passes for current roster members too.
 *   3. GET /enquiry honours opt-in ?includeTeam=1 (effectiveScopeFilter ORs the
 *      caller's roster lead ids into their ownership scope).
 *
 *   node tests/fix-team-scope.test.js
 *
 * Seeds isolated, uniquely-tagged docs against the local CRM DB; cleans up in
 * finally.
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
const LeadLifecycleService = require("../services/LeadLifecycleService");
const leadTeam = require("../controllers/leadTeam");
const { effectiveScopeFilter } = require("../controllers/enquiry");

const TAG = `team-scope-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const mockRes = () => ({
  statusCode: 0,
  body: null,
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; return this; },
  send(b) { this.body = b; return this; },
});

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

  const adminIds = [], leadIds = [];
  let dept = null;
  try {
    dept = await Department.create({ name: `${TAG}-sales` });
    const manager = await Admin.create({
      name: `${TAG}-manager`, email: `${TAG}-mgr@x.com`, phone: `${TAG}m`,
      password: "x", status: "active", departmentId: dept._id,
    });
    const intern = await Admin.create({
      name: `${TAG}-intern`, email: `${TAG}-int@x.com`, phone: `${TAG}i`,
      password: "x", status: "active", departmentId: dept._id,
      reportingManagerId: manager._id,
    });
    const helper = await Admin.create({
      name: `${TAG}-helper`, email: `${TAG}-hlp@x.com`, phone: `${TAG}h`,
      password: "x", status: "active", departmentId: dept._id,
    });
    const outsider = await Admin.create({
      name: `${TAG}-outsider`, email: `${TAG}-out@x.com`, phone: `${TAG}o`,
      password: "x", status: "active", departmentId: dept._id,
    });
    adminIds.push(manager._id, intern._id, helper._id, outsider._id);

    const lead = await Enquiry.create({
      name: "Team Scope Lead", phone: `${TAG}`, verified: false, isInterested: false,
      isLost: false, stage: "contacted", source: "Default", assignedTo: intern._id,
    });
    leadIds.push(lead._id);

    // ── 1. Qualify → handoff to the manager + roster continuity for the intern.
    console.log("1. qualifyLead hands off AND keeps the qualifier on the roster");
    const q = await LeadLifecycleService.qualifyLead(lead._id, intern._id);
    ok(q.handedOff === true, "handoff fired (assignee has a reporting manager)");
    ok(String(q.lead.assignedTo) === String(manager._id), "assignedTo moved to the manager");
    const roster = await LeadTeamMember.find({ leadId: lead._id, activeTo: null }).lean();
    ok(roster.some((r) => String(r.personId) === String(intern._id)), "pre-handoff owner auto-added to the roster");

    // Idempotent: qualifying again is a no-op (no duplicate roster row).
    await LeadLifecycleService.qualifyLead(lead._id, intern._id);
    const roster2 = await LeadTeamMember.find({ leadId: lead._id, personId: intern._id, activeTo: null }).lean();
    ok(roster2.length === 1, "re-qualify does not duplicate the roster row");

    // ── 2. The intern (own scope, no longer the owner) can manage the team.
    console.log("2. roster member passes the team-route scope guard");
    const addReq = {
      params: { _id: String(lead._id) },
      scopeFilter: { assignedTo: intern._id }, // own scope — lead now belongs to the manager
      auth: { user_id: String(intern._id) },
      body: { personId: String(helper._id) },
    };
    const addRes = mockRes();
    await leadTeam.Add(addReq, addRes);
    ok(addRes.statusCode === 201, `intern can add a team member post-handoff (got ${addRes.statusCode})`);
    const helperRow = await LeadTeamMember.findOne({ leadId: lead._id, personId: helper._id, activeTo: null }).lean();
    ok(!!helperRow, "helper actually landed on the roster");

    // Non-roster, out-of-scope caller still gets 403.
    const outsiderReq = {
      params: { _id: String(lead._id) },
      scopeFilter: { assignedTo: outsider._id },
      auth: { user_id: String(outsider._id) },
      body: { personId: String(outsider._id) },
    };
    const outsiderRes = mockRes();
    await leadTeam.Add(outsiderReq, outsiderRes);
    ok(outsiderRes.statusCode === 403, `outsider still 403s (got ${outsiderRes.statusCode})`);

    // ── 3. ?includeTeam=1 widens the list scope by roster membership.
    console.log("3. effectiveScopeFilter honours includeTeam");
    const own = { assignedTo: helper._id };
    const offFilter = await effectiveScopeFilter({ query: {}, scopeFilter: own, auth: { user_id: String(helper._id) } });
    const offHit = await Enquiry.findOne({ $and: [{ _id: lead._id }, offFilter] }).lean();
    ok(!offHit, "without includeTeam the roster lead is OUT of scope (off by default)");

    const onFilter = await effectiveScopeFilter({
      query: { includeTeam: "1" },
      scopeFilter: own,
      auth: { user_id: String(helper._id) },
    });
    const onHit = await Enquiry.findOne({ $and: [{ _id: lead._id }, onFilter] }).lean();
    ok(!!onHit, "with includeTeam=1 the roster lead is IN scope");

    // all-scope ({}) is never narrowed or widened.
    const allFilter = await effectiveScopeFilter({ query: { includeTeam: "1" }, scopeFilter: {}, auth: { user_id: String(helper._id) } });
    ok(Object.keys(allFilter).length === 0, "all-scope ({}) stays {} with includeTeam");
  } finally {
    if (leadIds.length) {
      await LeadTeamMember.deleteMany({ leadId: { $in: leadIds } });
      await LeadInternalEvent.deleteMany({ leadId: { $in: leadIds } });
      await AdminNotification.deleteMany({ leadId: { $in: leadIds } });
      await LeadStep.deleteMany({ leadId: { $in: leadIds } });
      await Enquiry.deleteMany({ _id: { $in: leadIds } });
    }
    if (adminIds.length) await Admin.deleteMany({ _id: { $in: adminIds } });
    if (dept) await Department.deleteMany({ _id: dept._id });
    await mongoose.disconnect();
  }

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("Test harness error:", e); process.exit(1); });
