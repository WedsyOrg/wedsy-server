// C2 — CS DASHBOARD test. Run: node tests/cs-dashboard.test.js
// Covers: gate (member via departmentId, member via hats, manager-of-CS,
// outsider 403), member vs manager shapes, handoffs, todayStats, mySteps
// noTask truth (active flags, Awaiting-client doesn't), awaiting rows,
// workload bands + manager rollup, leadsImOn health.
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const LeadLane = require("../models/LeadLane");
const LeadTask = require("../models/LeadTask");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const CsAccessService = require("../services/CsAccessService");
const CsDashboardService = require("../services/CsDashboardService");

const TAG = `csdash-${Date.now()}`;
const DAY = 24 * 60 * 60 * 1000;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { leads: [], admins: [], roles: [], lanes: [], tasks: [], events: [] };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const now = new Date();

    const csDept = await CsAccessService.csDepartment();
    ok(!!csDept, "client_servicing department resolves (seed-ensured)");

    const icRole = await Role.create({ name: `${TAG}-ic`, departmentId: csDept._id, permissions: ["leads:view:own"] });
    const mgrRole = await Role.create({ name: `${TAG}-mgr`, departmentId: csDept._id, permissions: ["leads:view:team"] });
    created.roles.push(icRole._id, mgrRole._id);
    const mkAdmin = (s, roleId, extra = {}) =>
      Admin.create({ name: `${TAG}-${s}`, email: `${TAG}-${s}@x.com`, phone: `${TAG}${s}`, password: "x", roles: ["sales"], status: "active", roleId, ...extra });
    const mgr = await mkAdmin("mgr", mgrRole._id); // NOT in CS — manages a CS member
    const csm = await mkAdmin("csm", icRole._id, { departmentId: csDept._id, reportingManagerId: mgr._id });
    const csmHat = await mkAdmin("csmhat", icRole._id, { hats: [{ departmentId: csDept._id, roleId: icRole._id, reportingManagerId: mgr._id }] });
    const salesOwner = await mkAdmin("owner", icRole._id);
    const rando = await mkAdmin("rando", icRole._id);
    created.admins.push(mgr._id, csm._id, csmHat._id, salesOwner._id, rando._id);

    const mkLead = (s, extra = {}) =>
      Enquiry.create({
        name: `${TAG}-${s}`, phone: `${TAG}-${s}`, verified: false, isInterested: false,
        isLost: false, stage: "contacted", source: "Default", lostStatus: "none",
        assignedTo: salesOwner._id, firstRespondedAt: now,
        qualificationData: { eventDate: "2026-11-20" }, ...extra,
      });

    const L1 = await mkLead("L1"); // planning lane (active, silent 5d, no task by csm) → noTask + at_risk
    const L2 = await mkLead("L2"); // task due today (participant via task)
    const L3 = await mkLead("L3"); // awaiting-client lane
    created.leads.push(L1._id, L2._id, L3._id);

    const laneA = await LeadLane.create({
      leadId: L1._id, key: "planning", name: "Planning", state: "active", ownerId: csm._id,
      lastUpdateAt: new Date(+now - 5 * DAY),
    });
    const laneB = await LeadLane.create({
      leadId: L3._id, key: "decor", name: "Decor", state: "paused", pausedReason: "Waiting on client", ownerId: csm._id,
      lastUpdateAt: new Date(+now - 3 * DAY),
    });
    created.lanes.push(laneA._id, laneB._id);

    const T1 = await LeadTask.create({ leadId: L2._id, title: `${TAG} send moodboard`, assigneeId: csm._id, assignerId: salesOwner._id, status: "open", dueAt: new Date(+now + 3600e3) });
    created.tasks.push(T1._id);
    const ev = await LeadInternalEvent.create({
      leadId: L2._id, type: "task_assigned", actorId: salesOwner._id,
      payload: { taskId: String(T1._id), title: `${TAG} send moodboard`, assigneeId: String(csm._id) },
    });
    created.events.push(ev._id);

    // ── gate ──
    let denied = null;
    try { await CsAccessService.csContext(rando._id); } catch (e) { denied = e; }
    ok(denied && denied.status === 403, "non-CS non-manager caller → 403");
    const hatCtx = await CsAccessService.csContext(csmHat._id);
    ok(hatCtx.isCsMember === true && hatCtx.isManagerView === false, "hats-only membership passes the gate as member");

    // ── member dashboard ──
    const ctx = await CsAccessService.csContext(csm._id);
    ok(ctx.isCsMember && !ctx.isManagerView, "CS member context is member view");
    const d = await CsDashboardService.dashboard(csm._id, ctx);
    ok(d.view === "member", "view = member");

    // handoffs
    const hTask = d.handoffs.find((h) => h.leadId === String(L2._id) && /Task assigned/.test(h.what));
    const hLane = d.handoffs.find((h) => h.leadId === String(L1._id) && /Lane assigned — Planning/.test(h.what));
    ok(!!hTask && hTask.byName === `${TAG}-owner` && hTask.eventDate === "2026-11-20", "task handoff row (byName + eventDate)");
    ok(!!hLane, "lane handoff row present");

    // todayStats
    ok(d.todayStats.dueToday >= 1, `dueToday counts the task (${d.todayStats.dueToday})`);
    ok(d.todayStats.activeLeads === 3, `activeLeads = participant leads (${d.todayStats.activeLeads})`);

    // mySteps + noTask truth
    const stepA = d.mySteps.find((s) => s.laneId === String(laneA._id));
    const stepB = d.mySteps.find((s) => s.laneId === String(laneB._id) && s.kind === "lane");
    const stepT = d.mySteps.find((s) => s.kind === "task" && s.leadId === String(L2._id));
    ok(!!stepA && stepA.noTask === true && stepA.displayStatus === "Started", "active lane with zero owner task → noTask true");
    ok(!!stepB && stepB.noTask === false && stepB.displayStatus === "Awaiting client", "Awaiting-client lane does NOT flag noTask");
    ok(!!stepT && String(new Date(stepT.dueAt).getTime()) === String(new Date(T1.dueAt).getTime()), "task row rides mySteps with dueAt");

    // awaiting
    ok(d.awaiting.length === 1 && d.awaiting[0].laneId === String(laneB._id) && d.awaiting[0].waitingDays === 3, "awaiting carries the client-paused lane with waitingDays");

    // workload (member shape)
    ok(d.workload && d.workload.open === 2 && d.workload.capacityBand === "has_room", `member workload {open:2, has_room} (${JSON.stringify(d.workload)})`);

    // leadsImOn
    const li1 = d.leadsImOn.find((l) => l.leadId === String(L1._id));
    const li2 = d.leadsImOn.find((l) => l.leadId === String(L2._id));
    ok(!!li1 && li1.myRole === "Planning" && li1.health === "at_risk", "silent-5d lane lead → at_risk with lane role");
    ok(!!li2 && li2.myRole === "Team" && li2.health === "on_track", "task-only lead → Team role, on_track");

    // ── manager dashboard ──
    const mgrCtx = await CsAccessService.csContext(mgr._id);
    ok(mgrCtx.isManagerView === true, "manager-of-CS gets manager view");
    const md = await CsDashboardService.dashboard(mgr._id, mgrCtx);
    ok(md.view === "manager" && Array.isArray(md.workload), "manager workload is a per-member rollup");
    const row = md.workload.find((r) => r.adminId === String(csm._id));
    ok(!!row && row.open === 2 && row.noTaskCount >= 1 && row.dueToday >= 1 && row.capacityBand === "has_room", `member rollup row correct (${JSON.stringify(row)})`);
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    await LeadInternalEvent.deleteMany({ _id: { $in: created.events } }).catch(() => {});
    await LeadLane.deleteMany({ _id: { $in: created.lanes } }).catch(() => {});
    await LeadTask.deleteMany({ _id: { $in: created.tasks } }).catch(() => {});
    await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
    await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
    await Role.deleteMany({ _id: { $in: created.roles } }).catch(() => {});
    await mongoose.disconnect();
    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
