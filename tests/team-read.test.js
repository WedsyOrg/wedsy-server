// W6 — TEAM READ test. Run: node tests/team-read.test.js
// Covers: member sets (manager → direct reports ONLY; RH → department;
// founder → everyone), rollups matching hand-computed numbers across BOTH
// follow-up stores (the M2 bridge), parked counts, and pending-approvals
// eligibility parity with the existing disqualify helpers.
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");
const Followup = require("../models/Followup");
const TeamReadService = require("../services/TeamReadService");
const { istDayStart } = require("../utils/goldenWindow");

const TAG = `teamread-${Date.now()}`;
const DAY = 24 * 60 * 60 * 1000;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { leads: [], admins: [], roles: [], depts: [] };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const now = new Date();
    const todayStart = istDayStart(now);

    const dept = await Department.create({ name: `${TAG}-dept`, slug: `${TAG}-d` });
    const otherDept = await Department.create({ name: `${TAG}-other`, slug: `${TAG}-o` });
    created.depts.push(dept._id, otherDept._id);
    const founderRole = await Role.create({ name: `${TAG}-founder`, departmentId: dept._id, permissions: ["*:*:all"] });
    const rhRole = await Role.create({ name: "Revenue Head", departmentId: dept._id, permissions: ["leads:view:team", "leads:approve:all"], description: TAG });
    const mgrRole = await Role.create({ name: `${TAG}-mgr`, departmentId: dept._id, permissions: ["leads:view:team"] });
    const icRole = await Role.create({ name: `${TAG}-ic`, departmentId: dept._id, permissions: ["leads:view:own"] });
    created.roles.push(founderRole._id, rhRole._id, mgrRole._id, icRole._id);

    const mkAdmin = (s, roleId, extra = {}) =>
      Admin.create({ name: `${TAG}-${s}`, email: `${TAG}-${s}@x.com`, phone: `${TAG}${s}`, password: "x", roles: ["sales"], status: "active", roleId, departmentId: dept._id, ...extra });
    const founder = await mkAdmin("founder", founderRole._id);
    const rh = await mkAdmin("rh", rhRole._id);
    const manager = await mkAdmin("mgr", mgrRole._id, { reportingManagerId: rh._id });
    const repA = await mkAdmin("repA", icRole._id, { reportingManagerId: manager._id });
    const repB = await mkAdmin("repB", icRole._id, { reportingManagerId: manager._id, isDisabled: true });
    const stranger = await mkAdmin("stranger", icRole._id, { departmentId: otherDept._id }); // other dept, no chain
    created.admins.push(founder._id, rh._id, manager._id, repA._id, repB._id, stranger._id);

    const mkLead = (s, assignee, extra = {}) =>
      Enquiry.create({
        name: `${TAG}-${s}`, phone: `${TAG}-${s}`, verified: false, isInterested: false,
        isLost: false, stage: "contacted", source: "Default", lostStatus: "none",
        assignedTo: assignee, ...extra,
      });

    // repA's book: 3 open (one parked), 1 won (not open).
    // cadence: 1 overdue (yesterday, open) + 1 due today. journey: 1 due today + 1 overdue.
    const a1 = await mkLead("a1", repA._id, {
      followUps: [
        { type: "call", scheduledAt: new Date(+todayStart - 2 * 3600e3), promiseNote: "", createdBy: repA._id }, // overdue
      ],
    });
    const a2 = await mkLead("a2", repA._id, {
      followUps: [
        { type: "call", scheduledAt: new Date(+todayStart + 3600e3), promiseNote: "", createdBy: repA._id }, // due today
      ],
    });
    const a3 = await mkLead("a3-parked", repA._id, { snoozedUntil: new Date(+now + 20 * DAY) });
    const aWon = await mkLead("a-won", repA._id, { stage: "won" });
    await Followup.create({ leadId: a1._id, title: `${TAG} j-due`, dueAt: new Date(+todayStart + 2 * 3600e3), ownerId: repA._id, status: "open" });
    await Followup.create({ leadId: a2._id, title: `${TAG} j-over`, dueAt: new Date(+todayStart - DAY), ownerId: repA._id, status: "open" });
    // done + snoozed-future journey rows must NOT count.
    await Followup.create({ leadId: a2._id, title: `${TAG} j-done`, dueAt: new Date(+todayStart + 3600e3), ownerId: repA._id, status: "done", completedAt: now });
    await Followup.create({ leadId: a1._id, title: `${TAG} j-snoozed`, dueAt: new Date(+todayStart + 3600e3), ownerId: repA._id, status: "snoozed", snoozedUntil: new Date(+now + 5 * DAY) });
    created.leads.push(a1._id, a2._id, a3._id, aWon._id);

    // pending disqualification on repA's lead — manager + RH eligible.
    const pend = await mkLead("pending", repA._id, { lostStatus: "pending", lostReason: "budget", lostRequestedBy: repA._id, lostRequestedAt: now });
    created.leads.push(pend._id);

    // ── Manager: direct reports only ──
    const mt = await TeamReadService.team(manager._id);
    const mNames = mt.members.map((m) => m.name).filter((n) => n.startsWith(TAG));
    ok(mNames.length === 2 && mNames.includes(`${TAG}-repA`) && mNames.includes(`${TAG}-repB`), "manager sees DIRECT reports only");
    ok(!mNames.includes(`${TAG}-mgr`) && !mNames.includes(`${TAG}-stranger`), "manager list excludes self and strangers");

    const rowA = mt.members.find((m) => m.name === `${TAG}-repA`);
    ok(rowA.openLeads === 4, `openLeads counts open-stage book incl parked + pending (${rowA.openLeads})`);
    ok(rowA.parked === 1, `parked counts the snoozed lead (${rowA.parked})`);
    // M2 bridge: cadence (lead-level) + journey rows, both stores.
    ok(rowA.dueToday === 2, `dueToday = 1 cadence lead + 1 journey row (${rowA.dueToday})`);
    ok(rowA.overdue === 2, `overdue = 1 cadence lead + 1 journey row (${rowA.overdue})`);
    ok(rowA.role === `${TAG}-ic` && rowA.status === "active" && rowA.isDisabled === false, "member row carries role/status/isDisabled");
    const rowB = mt.members.find((m) => m.name === `${TAG}-repB`);
    ok(rowB.isDisabled === true, "disabled member stays visible with isDisabled=true");

    // approvals — manager of assignee sees the pending item.
    const mApp = mt.pendingApprovals.items.filter((i) => (i.lead.name || "").startsWith(TAG));
    ok(mApp.length === 1 && String(mApp[0].lead._id) === String(pend._id), "manager sees the pending disqualification (manager-of-assignee path)");
    ok(mApp[0].reason === "budget" && mApp[0].requester, "approval item carries reason + requester");

    // ── RH: department members + approve-permission path ──
    const rt = await TeamReadService.team(rh._id);
    const rNames = rt.members.map((m) => m.name).filter((n) => n.startsWith(TAG));
    ok(rNames.includes(`${TAG}-repA`) && rNames.includes(`${TAG}-mgr`) && rNames.includes(`${TAG}-rh`), "RH sees the whole department");
    ok(!rNames.includes(`${TAG}-stranger`), "RH does not see other departments");
    ok(rt.pendingApprovals.items.some((i) => String(i.lead._id) === String(pend._id)), "RH sees the pending item via leads:approve permission");

    // ── Founder: everyone ──
    const ft = await TeamReadService.team(founder._id);
    const fNames = ft.members.map((m) => m.name).filter((n) => n.startsWith(TAG));
    ok(fNames.includes(`${TAG}-stranger`), "founder sees every member incl other departments");

    // ── IC (repA): no chain, no approve permission → empty members + approvals ──
    const at = await TeamReadService.team(repA._id);
    ok(at.members.filter((m) => m.name.startsWith(TAG)).length === 0, "IC has no reports → empty members");
    ok(at.pendingApprovals.items.filter((i) => (i.lead.name || "").startsWith(TAG)).length === 0, "IC sees no approvals (eligibility parity)");
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    await Followup.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
    await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
    await Role.deleteMany({ _id: { $in: created.roles } }).catch(() => {});
    await Department.deleteMany({ _id: { $in: created.depts } }).catch(() => {});
    await mongoose.disconnect();
    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
