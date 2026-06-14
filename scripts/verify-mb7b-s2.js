/* MB7b Slice 2 — tasks born-in-chat: create (in-chat + standalone) → thread
 * system post, complete → thread post, overdue → assigner + manager escalation
 * (set-once), my-tasks surface, RBAC scope. Port 8151. */
require("dotenv").config();
const { spawn } = require("child_process");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const PORT = 8151; const BASE = `http://localhost:${PORT}`; const MARK = "MB7B-S2";
let pass = 0, fail = 0; const failures = [];
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; failures.push(l); console.error(`  ✗ ${l}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, l, t = 30000) => { const u = Date.now() + t; while (Date.now() < u) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(300); } throw new Error(`waitFor: ${l}`); };

(async () => {
  await mongoose.connect(process.env.DATABASE_URL);
  const Admin = require("../models/Admin"); const Role = require("../models/Role"); const Department = require("../models/Department");
  const Enquiry = require("../models/Enquiry"); const LeadTask = require("../models/LeadTask");
  const LeadChatMessage = require("../models/LeadChatMessage"); const LeadInternalEvent = require("../models/LeadInternalEvent");
  const AdminNotification = require("../models/AdminNotification");
  const LeadTaskService = require("../services/LeadTaskService");

  const dept = await Department.create({ name: `${MARK} Dept` });
  const allRole = await Role.create({ name: `${MARK} All`, departmentId: dept._id, permissions: ["leads:view:all", "leads:edit:all"] });
  const ownRole = await Role.create({ name: `${MARK} Own`, departmentId: dept._id, permissions: ["leads:view:own", "leads:edit:own"] });
  const u = (s) => `9196${String(Date.now()).slice(-7)}${s}`;
  const M = await Admin.create({ name: `${MARK} Mgr`, email: `s2m-${Date.now()}@t.local`, phone: u(0), password: "x", roleIds: [allRole._id], departmentId: dept._id, status: "active" });
  const A = await Admin.create({ name: `${MARK} A`, email: `s2a-${Date.now()}@t.local`, phone: u(1), password: "x", roleIds: [allRole._id], departmentId: dept._id, reportingManagerId: M._id, status: "active" });
  const B = await Admin.create({ name: `${MARK} B`, email: `s2b-${Date.now()}@t.local`, phone: u(2), password: "x", roleIds: [allRole._id], departmentId: dept._id, status: "active" });
  const C = await Admin.create({ name: `${MARK} C`, email: `s2c-${Date.now()}@t.local`, phone: u(3), password: "x", roleIds: [ownRole._id], departmentId: dept._id, status: "active" });
  const tok = (a) => jwt.sign({ _id: String(a._id), isAdmin: true }, process.env.JWT_SECRET);
  const aT = tok(A), bT = tok(B), cT = tok(C);

  const phone = `9191${String(Date.now()).slice(-8)}`;
  const lead = await Enquiry.create({ name: "Task Couple", phone, verified: false, source: "Website", stage: "lead", assignedTo: A._id, additionalInfo: {} });

  const child = spawn("node", ["server.js"], { cwd: `${__dirname}/..`, env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const api = async (m, p, t, b) => { const r = await fetch(`${BASE}${p}`, { method: m, headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(b ? { "Content-Type": "application/json" } : {}) }, body: b ? JSON.stringify(b) : undefined }); let d = null; try { d = await r.json(); } catch (_) {} return { status: r.status, data: d }; };

  try {
    await waitFor(() => fetch(`${BASE}/`).then((r) => r.ok).catch(() => false), "boot");

    console.log("\n── Create from within chat → thread post + notify assignee ──");
    const chatMsg = await api("POST", `/enquiry/${lead._id}/chat`, aT, { body: "Let's get a quote out" });
    const created = await api("POST", `/lead-tasks`, aT, { leadId: String(lead._id), title: "Send the quote", assigneeId: String(B._id), dueAt: new Date(Date.now() + 86400000).toISOString(), createdInChatMessageId: chatMsg.data._id });
    ok(created.status === 201 && created.data.assigneeId === String(B._id) && created.data.createdInChatMessageId === chatMsg.data._id, "A creates a task in chat assigned to B");
    const sysCreate = await LeadChatMessage.findOne({ leadId: lead._id, kind: "system", systemType: "task_created", taskId: created.data._id }).lean();
    ok(!!sysCreate && /Task created for .* Send the quote/.test(sysCreate.body), "lifecycle posted a system chat message: Task created for <assignee>");
    const jCreate = await LeadInternalEvent.countDocuments({ leadId: lead._id, type: "task_created" });
    ok(jCreate === 1, "task_created journey event recorded");
    const notifB = await AdminNotification.countDocuments({ adminId: B._id, type: "task_assigned" });
    ok(notifB === 1, "assignee B notified (task_assigned)");

    console.log("\n── Standalone create on the lead ──");
    const standalone = await api("POST", `/lead-tasks`, aT, { leadId: String(lead._id), title: "Call the venue", assigneeId: String(A._id), dueAt: new Date(Date.now() + 86400000).toISOString() });
    ok(standalone.status === 201 && !standalone.data.createdInChatMessageId, "standalone task (no chat message link)");

    console.log("\n── Complete → thread post ──");
    const done = await api("PUT", `/lead-tasks/${created.data._id}/complete`, bT);
    ok(done.status === 200 && done.data.status === "done" && done.data.completedAt, "B completes the task");
    const sysDone = await LeadChatMessage.findOne({ leadId: lead._id, kind: "system", systemType: "task_completed", taskId: created.data._id }).lean();
    ok(!!sysDone && /Task completed: Send the quote/.test(sysDone.body), "lifecycle posted a system chat message: Task completed");
    ok((await LeadInternalEvent.countDocuments({ leadId: lead._id, type: "task_completed" })) === 1, "task_completed journey event recorded");

    console.log("\n── My-tasks surface (overdue highlighted) ──");
    // An overdue open task assigned to B, assigner A.
    const overdue = await LeadTask.create({ leadId: lead._id, title: "Overdue follow", assigneeId: B._id, assignerId: A._id, dueAt: new Date(Date.now() - 86400000) });
    const mine = await api("GET", `/lead-tasks/mine`, bT);
    const row = (mine.data.list || []).find((t) => String(t._id) === String(overdue._id));
    ok(mine.status === 200 && row && row.overdue === true && row.lead, "B's my-tasks shows the overdue task flagged + lead attached");
    const aMine = await api("GET", `/lead-tasks/mine`, aT);
    ok((aMine.data.list || []).some((t) => t.title === "Call the venue"), "A's my-tasks shows their own standalone task");

    console.log("\n── Overdue → assigner + manager escalation (set-once) ──");
    const before = await AdminNotification.countDocuments({ adminId: { $in: [A._id, M._id] }, type: "task_overdue" });
    const esc1 = await LeadTaskService.escalateOverdue(new Date());
    ok(esc1.escalated >= 1, "escalateOverdue escalates the overdue task");
    const assignerNotif = await AdminNotification.countDocuments({ adminId: A._id, type: "task_overdue" });
    const mgrNotif = await AdminNotification.countDocuments({ adminId: M._id, type: "task_overdue" });
    ok(assignerNotif >= 1 && mgrNotif >= 1, "assigner A + A's reporting manager M both notified");
    const esc2 = await LeadTaskService.escalateOverdue(new Date());
    const afterAgain = await LeadTask.findById(overdue._id).lean();
    ok(afterAgain.overdueEscalatedAt && esc2.escalated === 0, "set-once: a second sweep does not re-escalate");

    console.log("\n── RBAC scope ──");
    const denied = await api("POST", `/lead-tasks`, cT, { leadId: String(lead._id), title: "x", assigneeId: String(C._id), dueAt: new Date(Date.now() + 86400000).toISOString() });
    ok(denied.status === 403, "out-of-scope admin → 403 creating a task on a lead they can't see");
    const badList = await api("GET", `/lead-tasks?leadId=${lead._id}`, cT);
    ok(badList.status === 403, "out-of-scope admin → 403 listing a lead's tasks");
  } catch (e) {
    fail++; failures.push(`fatal: ${e.message}`); console.error("FATAL", e); console.error(log.slice(-1500));
  } finally {
    await LeadTask.deleteMany({ leadId: lead._id }); await LeadChatMessage.deleteMany({ leadId: lead._id });
    await LeadInternalEvent.deleteMany({ leadId: lead._id });
    await AdminNotification.deleteMany({ adminId: { $in: [A._id, B._id, C._id, M._id] } });
    await Enquiry.deleteMany({ _id: lead._id });
    await Admin.deleteMany({ _id: { $in: [A._id, B._id, C._id, M._id] } });
    await Role.deleteMany({ _id: { $in: [allRole._id, ownRole._id] } });
    await Department.deleteMany({ _id: dept._id });
    child.kill(); await mongoose.disconnect();
    console.log(`\n══ RESULT: ${pass} passed, ${fail} failed ══`);
    if (failures.length) console.log("failures:", failures.join(" | "));
    process.exit(fail === 0 ? 0 : 1);
  }
})();
