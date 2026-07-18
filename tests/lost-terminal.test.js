// FIX L1 — LOST IS TERMINAL test. Run: node tests/lost-terminal.test.js
// One lead planted on every work surface. While lostStatus="pending" it stays
// LIVE everywhere; the moment DecideDisqualify APPROVES it vanishes from every
// consumer, its escalation marks are cleaned up, and a snoozed+lost lead never
// wakes.
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const LeadLane = require("../models/LeadLane");
const LeadTask = require("../models/LeadTask");
const Followup = require("../models/Followup");
const EscalationMark = require("../models/EscalationMark");
const AdminNotification = require("../models/AdminNotification");
const LaneEntry = require("../models/LaneEntry");
const MyWorkService = require("../services/MyWorkService");
const BoardService = require("../services/BoardService");
const CommitmentService = require("../services/CommitmentService");
const GoldenWindowService = require("../services/GoldenWindowService");
const RescueService = require("../services/RescueService");
const TriageService = require("../services/TriageService");
const TeamReadService = require("../services/TeamReadService");
const NoTaskService = require("../services/NoTaskService");
const SnoozeService = require("../services/SnoozeService");
const EscalationReadService = require("../services/EscalationReadService");
const EnquiryService = require("../services/EnquiryService");
const CsAccessService = require("../services/CsAccessService");
const CsDashboardService = require("../services/CsDashboardService");
const DashboardSectionsService = require("../services/DashboardSectionsService");
const { istDayStart } = require("../utils/goldenWindow");

const TAG = `lostterm-${Date.now()}`;
const DAY = 24 * 60 * 60 * 1000;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { leads: [], admins: [], roles: [], lanes: [], tasks: [] };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const now = new Date();
    const todayStart = istDayStart(now);

    const csDept = await CsAccessService.csDepartment();
    const mgrRole = await Role.create({ name: `${TAG}-mgr`, departmentId: csDept._id, permissions: ["leads:view:team"] });
    const icRole = await Role.create({ name: `${TAG}-ic`, departmentId: csDept._id, permissions: ["leads:view:own"] });
    created.roles.push(mgrRole._id, icRole._id);
    const manager = await Admin.create({ name: `${TAG}-mgr`, email: `${TAG}-m@x.com`, phone: `${TAG}m`, password: "x", roles: ["sales"], status: "active", roleId: mgrRole._id });
    // seller is ALSO a CS member so the CS dashboard leg can assert.
    const seller = await Admin.create({ name: `${TAG}-seller`, email: `${TAG}-s@x.com`, phone: `${TAG}s`, password: "x", roles: ["sales"], status: "active", roleId: icRole._id, departmentId: csDept._id, reportingManagerId: manager._id });
    created.admins.push(manager._id, seller._id);

    // ── LX: the everything-lead, PENDING-lost ──
    const LX = await Enquiry.create({
      name: `${TAG}-LX`, phone: `${TAG}-LX`, verified: false, isInterested: false,
      isLost: false, stage: "contacted", source: "Default",
      lostStatus: "pending", lostReason: "budget", lostRequestedBy: seller._id, lostRequestedAt: now,
      assignedTo: seller._id, firstRespondedAt: now, needsHumanQualification: true,
      followUps: [{ type: "call", scheduledAt: new Date(+todayStart - 3600e3), promiseNote: "chase", createdBy: seller._id }],
    });
    const lane = await LeadLane.create({ leadId: LX._id, key: "planning", name: "Planning", state: "active", ownerId: seller._id, lastUpdateAt: new Date(+now - 5 * DAY) });
    const jf = await Followup.create({ leadId: LX._id, title: `${TAG} touch`, dueAt: new Date(+todayStart + 3600e3), ownerId: seller._id, status: "open" });
    const task = await LeadTask.create({ leadId: LX._id, title: `${TAG} task`, assigneeId: seller._id, assignerId: manager._id, status: "open", dueAt: new Date(+todayStart + 2 * 3600e3) });
    const mark = await EscalationMark.create({ key: `lane:${LX._id}:${lane.key}:2:${+new Date(+now - 5 * DAY)}`, leadId: LX._id, kind: "lane", rung: 2, firedAt: now });
    created.lanes.push(lane._id); created.tasks.push(task._id);
    // LR: respond-now twin (pending-lost, breached window)
    const LR = await Enquiry.create({
      name: `${TAG}-LR`, phone: `${TAG}-LR`, verified: false, isInterested: false,
      isLost: false, stage: "new", source: "Default", lostStatus: "pending",
      lostRequestedBy: seller._id, lostRequestedAt: now,
      assignedTo: seller._id, firstRespondedAt: null, firstCalledAt: null, createdAt: new Date(+now - 2 * 3600e3),
    });
    // LS: snoozed + pending-lost with a wake date in the past
    const LS = await Enquiry.create({
      name: `${TAG}-LS`, phone: `${TAG}-LS`, verified: false, isInterested: false,
      isLost: false, stage: "contacted", source: "Default", lostStatus: "pending",
      lostRequestedBy: seller._id, lostRequestedAt: now,
      assignedTo: seller._id, firstRespondedAt: now, snoozedUntil: new Date(+now - 3600e3),
    });
    // LT: legacy bulk-lost triage lead (isLost true, lostStatus none)
    const LT = await Enquiry.create({
      name: `${TAG}-LT`, phone: `${TAG}-LT`, verified: false, isInterested: false,
      isLost: true, stage: "new", source: "Default", lostStatus: "none",
      assignedTo: null, triagePending: true,
    });
    // LN: pending-lost with a TASK-LESS active lane (the no-task pass target —
    // LX's lane is "driven" by the open task fixture, so it never flags).
    const LN = await Enquiry.create({
      name: `${TAG}-LN`, phone: `${TAG}-LN`, verified: false, isInterested: false,
      isLost: false, stage: "contacted", source: "Default", lostStatus: "pending",
      lostRequestedBy: seller._id, lostRequestedAt: now,
      assignedTo: seller._id, firstRespondedAt: now,
    });
    const laneN = await LeadLane.create({ leadId: LN._id, key: "decor", name: "Decor", state: "active", ownerId: manager._id, lastUpdateAt: now });
    created.lanes.push(laneN._id);
    created.leads.push(LX._id, LR._id, LS._id, LT._id, LN._id);

    const teamFilter = { assignedTo: { $in: [manager._id, seller._id] } };
    const fixtureFilter = { _id: { $in: created.leads } };
    const hasLX = (arr, key = "leadId") => (arr || []).some((i) => String(i[key]) === String(LX._id));

    // ════ PHASE 1 — PENDING: live everywhere ════
    const q1 = await MyWorkService.now(seller._id);
    ok(hasLX(q1.items), "PENDING · my-work/now carries the lead");
    const s1 = await MyWorkService.schedule(seller._id);
    ok(s1.days.some((d) => hasLX(d.items)) || (s1.overdue && hasLX(s1.overdue.items)), "PENDING · my-work/schedule carries the lead");
    const b1 = await BoardService.board(manager._id, "team", teamFilter);
    ok(b1.columns.working.leads.some((l) => String(l._id) === String(LX._id)), "PENDING · board keeps it in the working column");
    const rm1 = await CommitmentService.rowMarks([await Enquiry.findById(LX._id).lean()], { scope: "team", callerId: manager._id });
    const m1 = rm1.get(String(LX._id));
    ok(m1.overdue + m1.dueToday >= 2, "PENDING · rowMarks count its commitments");
    const rn1 = await GoldenWindowService.respondNow(seller._id, now);
    ok(rn1.rows.some((r) => String(r._id) === String(LR._id)), "PENDING · respond-now carries the twin");
    const rq1 = await RescueService.rescueQueue(manager._id, "team", now);
    ok(rq1.rows.some((r) => String(r._id) === String(LR._id)), "PENDING · rescue carries the twin");
    const t1 = await TeamReadService.team(manager._id);
    const row1 = t1.members.find((m) => m.name === `${TAG}-seller`);
    ok(row1 && row1.dueToday >= 1 && row1.overdue >= 1, "PENDING · team rollup counts both stores");
    const nt1 = await NoTaskService.sweepNoTask(now, { _id: { $in: [LN._id] } });
    ok(nt1.flagged >= 1, "PENDING · no-task sweep still flags (lead is live)");
    const er1 = await EscalationReadService.list({ callerId: manager._id, reqScope: "team", reqScopeFilter: teamFilter, page: 1, limit: 50 });
    ok(hasLX(er1.items), "PENDING · escalations read carries the open episode");
    const csCtx = await CsAccessService.csContext(seller._id);
    const cs1 = await CsDashboardService.dashboard(seller._id, csCtx);
    ok(hasLX(cs1.mySteps), "PENDING · CS mySteps carries the lane");
    ok(hasLX(cs1.leadsImOn), "PENDING · CS leadsImOn carries the lead");
    const ds1 = await DashboardSectionsService.buildWorkspaceSections(manager._id, "team", teamFilter);
    ok(hasLX(ds1.awaitingHumanQualification.rows), "PENDING · awaiting-human-qualification carries it");

    // ════ APPROVE (the vanish trigger) ════
    await EnquiryService.decideDisqualification(LX._id, { decision: "approve" }, manager._id, true);
    await EnquiryService.decideDisqualification(LR._id, { decision: "approve" }, manager._id, true);
    await EnquiryService.decideDisqualification(LS._id, { decision: "approve" }, manager._id, true);
    await EnquiryService.decideDisqualification(LN._id, { decision: "approve" }, manager._id, true);

    // ════ PHASE 2 — APPROVED: gone everywhere ════
    const q2 = await MyWorkService.now(seller._id);
    ok(!hasLX(q2.items), "APPROVED · my-work/now drops it");
    const s2 = await MyWorkService.schedule(seller._id);
    ok(!s2.days.some((d) => hasLX(d.items)) && !(s2.overdue && hasLX(s2.overdue.items)), "APPROVED · my-work/schedule drops it");
    const b2 = await BoardService.board(manager._id, "team", teamFilter);
    ok(!b2.columns.working.leads.some((l) => String(l._id) === String(LX._id)), "APPROVED · gone from active board columns");
    ok(b2.columns.lost.leads.some((l) => String(l._id) === String(LX._id)), "APPROVED · the lost column itself keeps it");
    const rm2 = await CommitmentService.rowMarks([await Enquiry.findById(LX._id).lean()], { scope: "team", callerId: manager._id });
    const m2 = rm2.get(String(LX._id));
    ok(m2.overdue === 0 && m2.dueToday === 0, "APPROVED · rowMarks zero out");
    const rn2 = await GoldenWindowService.respondNow(seller._id, now);
    ok(!rn2.rows.some((r) => String(r._id) === String(LR._id)), "APPROVED · respond-now drops the twin");
    const rq2 = await RescueService.rescueQueue(manager._id, "team", now);
    ok(!rq2.rows.some((r) => String(r._id) === String(LR._id)), "APPROVED · rescue drops the twin");
    const t2 = await TeamReadService.team(manager._id);
    const row2 = t2.members.find((m) => m.name === `${TAG}-seller`);
    ok(row2 && row2.dueToday === 0 && row2.overdue === 0, "APPROVED · team rollup drops both stores");
    const nt2 = await NoTaskService.sweepNoTask(now, fixtureFilter);
    ok(nt2.flagged === 0, "APPROVED · no-task sweep skips every fixture lead");
    ok((await EscalationMark.countDocuments({ leadId: LX._id })) === 0, "APPROVED · escalation marks proactively cleaned up");
    const er2 = await EscalationReadService.list({ callerId: manager._id, reqScope: "team", reqScopeFilter: teamFilter, page: 1, limit: 50 });
    ok(!hasLX(er2.items), "APPROVED · escalations read shows no episode");
    const cs2 = await CsDashboardService.dashboard(seller._id, csCtx);
    ok(!hasLX(cs2.mySteps) && !hasLX(cs2.leadsImOn) && !hasLX(cs2.awaiting), "APPROVED · CS dashboard drops lane/lead everywhere");
    ok(cs2.workload.open === 0, "APPROVED · CS workload no longer counts the lane");
    const ds2 = await DashboardSectionsService.buildWorkspaceSections(manager._id, "team", teamFilter);
    ok(!hasLX(ds2.awaitingHumanQualification.rows), "APPROVED · awaiting-human-qualification drops it");
    // triage: legacy isLost lead excluded
    const tri = await TriageService.listTriage();
    ok(!tri.some((l) => String(l._id) === String(LT._id)), "legacy isLost triage lead excluded from the pool");
    // snoozed + lost never wakes
    const wake = await SnoozeService.wakeSweep(now, { _id: { $in: [LS._id] } });
    ok(wake.woken === 0, "APPROVED · snoozed+lost lead does NOT wake");
    const lsAfter = await Enquiry.findById(LS._id, { snoozedUntil: 1 }).lean();
    ok(!!lsAfter.snoozedUntil, "APPROVED · its snooze fields are untouched (no lead_woken)");
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    await EscalationMark.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await AdminNotification.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await LaneEntry.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await Followup.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await LeadTask.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await LeadLane.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
    await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
    await Role.deleteMany({ _id: { $in: created.roles } }).catch(() => {});
    await mongoose.disconnect();
    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
