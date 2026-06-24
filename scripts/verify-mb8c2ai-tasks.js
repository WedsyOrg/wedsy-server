/* MB8c-2a-i — per-step tasks. Verifies create/list/edit/toggle on a journey
 * step, owner-from-roster validation, overdue flag, actor-named journey events,
 * and that the MB7b lead-task + step-note mirror are untouched. Test port 8158. */
require("dotenv").config();
const { spawn } = require("child_process");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const PORT = 8158; const BASE = `http://localhost:${PORT}`; const MARK = "MB8C2AI";
let pass = 0, fail = 0; const failures = [];
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; failures.push(l); console.error(`  ✗ ${l}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, l, t = 30000) => { const u = Date.now() + t; while (Date.now() < u) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(300); } throw new Error(`waitFor: ${l}`); };

(async () => {
  await mongoose.connect(process.env.DATABASE_URL);
  const Admin = require("../models/Admin"); const Role = require("../models/Role"); const Department = require("../models/Department");
  const Enquiry = require("../models/Enquiry"); const LeadStep = require("../models/LeadStep"); const LeadTask = require("../models/LeadTask");
  const LeadTeamMember = require("../models/LeadTeamMember"); const LeadInternalEvent = require("../models/LeadInternalEvent");
  const AdminNotification = require("../models/AdminNotification");

  const dept = await Department.create({ name: `${MARK} Dept` });
  const role = await Role.create({ name: `${MARK} All`, departmentId: dept._id, permissions: ["leads:view:all", "leads:edit:all"] });
  const u = (s) => `9197${String(Date.now()).slice(-7)}${s}`;
  const BOSS = await Admin.create({ name: `${MARK} Boss`, email: `boss-${Date.now()}@t.local`, phone: u(1), password: "x", roleIds: [role._id], departmentId: dept._id, status: "active" });
  const MATE = await Admin.create({ name: `${MARK} Mate`, email: `mate-${Date.now()}@t.local`, phone: u(2), password: "x", roleIds: [role._id], departmentId: dept._id, status: "active" });
  const OUTSIDER = await Admin.create({ name: `${MARK} Outsider`, email: `out-${Date.now()}@t.local`, phone: u(3), password: "x", roleIds: [role._id], status: "active" });
  const bossT = jwt.sign({ _id: String(BOSS._id), isAdmin: true }, process.env.JWT_SECRET);

  const lead = await Enquiry.create({ name: `${MARK} Couple`, phone: `9190${String(Date.now()).slice(-8)}`, verified: false, source: "Website", stage: "lead", assignedTo: BOSS._id, additionalInfo: {} });
  const step = await LeadStep.create({ leadId: lead._id, name: "Decor Concept Discussion", phase: "Client Servicing & Proposal", order: 10, status: "in_progress" });
  // BOSS + MATE on the roster (eligible task owners); OUTSIDER is not.
  await LeadTeamMember.create({ leadId: lead._id, personId: BOSS._id, addedBy: BOSS._id });
  await LeadTeamMember.create({ leadId: lead._id, personId: MATE._id, addedBy: BOSS._id });

  const child = spawn("node", ["server.js"], { cwd: `${__dirname}/..`, env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const api = async (m, p, t, b) => { const r = await fetch(`${BASE}${p}`, { method: m, headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(b ? { "Content-Type": "application/json" } : {}) }, body: b ? JSON.stringify(b) : undefined }); let d = null; try { d = await r.json(); } catch (_) {} return { status: r.status, data: d }; };
  const base = `/enquiry/${lead._id}/steps/${step._id}/tasks`;

  try {
    await waitFor(() => fetch(`${BASE}/`).then((r) => r.ok).catch(() => false), "boot");

    console.log("\n── create / list ──");
    const t1 = await api("POST", base, bossT, { title: "Draft 3 decor moodboards", assigneeId: String(MATE._id), dueAt: new Date(Date.now() - 86400000).toISOString() });
    ok(t1.status === 201 && t1.data.title === "Draft 3 decor moodboards" && String(t1.data.stepId) === String(step._id), "create a step task linked to the step");
    ok(String(t1.data.assigneeId) === String(MATE._id), "owner assigned from the roster");
    ok(t1.data.overdue === true, "past due + open → overdue");
    const t2 = await api("POST", base, bossT, { title: "Ownerless undated task" });
    ok(t2.status === 201 && !t2.data.assigneeId && !t2.data.dueAt && t2.data.overdue === false, "ownerless + undated task allowed (not overdue)");
    const list = await api("GET", base, bossT);
    ok(list.status === 200 && list.data.list.length === 2, "list returns the step's tasks");

    console.log("\n── owner must be on the roster ──");
    const offRoster = await api("POST", base, bossT, { title: "x", assigneeId: String(OUTSIDER._id) });
    ok(offRoster.status === 400, "off-roster owner rejected");

    console.log("\n── edit ──");
    const edited = await api("PATCH", `${base}/${t2.data._id}`, bossT, { title: "Renamed task", assigneeId: String(BOSS._id) });
    ok(edited.status === 200 && edited.data.title === "Renamed task" && String(edited.data.assigneeId) === String(BOSS._id), "edit title + assignee");

    console.log("\n── toggle done / reopen + journey events ──");
    const done = await api("PATCH", `${base}/${t1.data._id}`, bossT, { toggle: true });
    ok(done.status === 200 && done.data.status === "done" && !!done.data.completedAt, "toggle → done (completedAt set)");
    const reopened = await api("PATCH", `${base}/${t1.data._id}`, bossT, { toggle: true });
    ok(reopened.status === 200 && reopened.data.status === "open" && !reopened.data.completedAt, "toggle again → reopened");

    const journey = (await api("GET", `/enquiry/${lead._id}/journey`, bossT)).data.entries || [];
    const created = journey.find((e) => e.type === "step_task_created");
    ok(created && created.actor === `${MARK} Boss` && /Task added: "Draft 3 decor moodboards".*Decor Concept/.test(created.title), `journey step_task_created names actor + task + step ("${created && created.title}")`);
    ok(journey.some((e) => e.type === "step_task_completed") && journey.some((e) => e.type === "step_task_reopened"), "journey records complete + reopen events");

    console.log("\n── regression: MB7b lead task + step-note mirror intact ──");
    const leadTask = await api("POST", "/lead-tasks", bossT, { leadId: String(lead._id), title: "MB7b task", assigneeId: String(MATE._id), dueAt: new Date(Date.now() + 86400000).toISOString() });
    ok(leadTask.status === 201 && !leadTask.data.stepId, "MB7b lead-level task still works (no stepId)");
    const note = await api("POST", `/enquiry/${lead._id}/steps/${step._id}/notes`, bossT, { body: "decor note", mentions: [String(MATE._id)] });
    ok(note.status === 201, "MB8b step note still posts");
    const chat = (await api("GET", `/enquiry/${lead._id}/chat`, bossT)).data.messages || [];
    ok(chat.some((m) => m.systemType === "step_note" && /decor note/.test(m.body)), "step note still mirrors into the lead chat");
    ok(!chat.some((m) => m.systemType === "step_task_created"), "step TASKS do NOT post to chat (journey-only, quiet)");
  } catch (e) {
    fail++; failures.push(`fatal: ${e.message}`); console.error("FATAL", e); console.error(log.slice(-2000));
  } finally {
    await LeadTask.deleteMany({ leadId: lead._id });
    await LeadStep.deleteMany({ leadId: lead._id });
    await LeadTeamMember.deleteMany({ leadId: lead._id });
    await LeadInternalEvent.deleteMany({ leadId: lead._id });
    await require("../models/LeadChatMessage").deleteMany({ leadId: lead._id });
    await AdminNotification.deleteMany({ adminId: { $in: [BOSS._id, MATE._id, OUTSIDER._id] } });
    await Enquiry.deleteMany({ _id: lead._id });
    await Admin.deleteMany({ _id: { $in: [BOSS._id, MATE._id, OUTSIDER._id] } });
    await Role.deleteMany({ _id: role._id });
    await Department.deleteMany({ _id: dept._id });
    child.kill(); await mongoose.disconnect();
    console.log(`\n══ RESULT: ${pass} passed, ${fail} failed ══`);
    if (failures.length) console.log("failures:", failures.join(" | "));
    process.exit(fail === 0 ? 0 : 1);
  }
})();
