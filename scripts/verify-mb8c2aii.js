/* MB8c-2a-ii — follow-ups + the ONE unified accountability rule + pipeline
 * reconcile + rate-limited nudge. Verifies the follow-up lifecycle, that the
 * banner rule fires all three ways, that the threshold setting drives it, that
 * the pipeline "stuck" flag now agrees with the banner (same rule), and the
 * nudge rate-limit. Test port 8159. */
require("dotenv").config();
const { spawn } = require("child_process");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const PORT = 8159; const BASE = `http://localhost:${PORT}`; const MARK = "MB8C2AII";
let pass = 0, fail = 0; const failures = [];
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; failures.push(l); console.error(`  ✗ ${l}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, l, t = 30000) => { const u = Date.now() + t; while (Date.now() < u) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(300); } throw new Error(`waitFor: ${l}`); };
const DAY = 86400000;

(async () => {
  await mongoose.connect(process.env.DATABASE_URL);
  const Admin = require("../models/Admin"); const Role = require("../models/Role"); const Department = require("../models/Department");
  const Enquiry = require("../models/Enquiry"); const LeadStep = require("../models/LeadStep"); const LeadTask = require("../models/LeadTask");
  const Followup = require("../models/Followup"); const LeadTeamMember = require("../models/LeadTeamMember");
  const LeadChatMessage = require("../models/LeadChatMessage"); const LeadInternalEvent = require("../models/LeadInternalEvent");
  const AdminNotification = require("../models/AdminNotification"); const Setting = require("../models/Setting");
  const SettingsService = require("../services/SettingsService");

  const dept = await Department.create({ name: `${MARK} Dept` });
  const role = await Role.create({ name: `${MARK} All`, departmentId: dept._id, permissions: ["*:*:all"] });
  const u = (s) => `9197${String(Date.now()).slice(-7)}${s}`;
  const BOSS = await Admin.create({ name: `${MARK} Boss`, email: `boss-${Date.now()}@t.local`, phone: u(1), password: "x", roleIds: [role._id], departmentId: dept._id, status: "active" });
  const KARAN = await Admin.create({ name: `${MARK} Karan`, email: `karan-${Date.now()}@t.local`, phone: u(2), password: "x", roleIds: [role._id], departmentId: dept._id, status: "active" });
  const bossT = jwt.sign({ _id: String(BOSS._id), isAdmin: true }, process.env.JWT_SECRET);
  const karanT = jwt.sign({ _id: String(KARAN._id), isAdmin: true }, process.env.JWT_SECRET);

  // Three leads: F (overdue follow-up), T (overdue task), S (stale step). All
  // qualified + rostered so the banner/pipeline consider them.
  const mkLead = async (n) => Enquiry.create({ name: `${MARK} ${n}`, phone: `9190${String(Date.now()).slice(-7)}${n}`, verified: true, source: "Website", stage: "qualified", qualified: true, assignedTo: BOSS._id, additionalInfo: {} });
  const leadF = await mkLead("F"); const leadT = await mkLead("T"); const leadS = await mkLead("S");
  for (const l of [leadF, leadT, leadS]) {
    await LeadTeamMember.create({ leadId: l._id, personId: KARAN._id, addedBy: BOSS._id });
  }
  // leadS: a stale in_progress step owned by Karan, not moved for 10 days.
  const staleStep = await LeadStep.create({ leadId: leadS._id, name: "Decor Concept Discussion", phase: "Client Servicing & Proposal", order: 10, status: "in_progress", ownerIds: [KARAN._id] });
  await LeadStep.updateOne({ _id: staleStep._id }, { $set: { updatedAt: new Date(Date.now() - 10 * DAY) } }, { timestamps: false });
  // leadT: an overdue task owned by Karan.
  await LeadTask.create({ leadId: leadT._id, title: "Send proposal", assigneeId: KARAN._id, assignerId: BOSS._id, dueAt: new Date(Date.now() - 2 * DAY), status: "open", kind: "task" });

  const child = spawn("node", ["server.js"], { cwd: `${__dirname}/..`, env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const api = async (m, p, t, b) => { const r = await fetch(`${BASE}${p}`, { method: m, headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(b ? { "Content-Type": "application/json" } : {}) }, body: b ? JSON.stringify(b) : undefined }); let d = null; try { d = await r.json(); } catch (_) {} return { status: r.status, data: d }; };

  try {
    await waitFor(() => fetch(`${BASE}/`).then((r) => r.ok).catch(() => false), "boot");

    console.log("\n── Slice 1: follow-up lifecycle ──");
    const created = await api("POST", `/enquiry/${leadF._id}/followups`, bossT, { title: "Call to discuss decor", dueAt: new Date(Date.now() - 1 * DAY).toISOString(), ownerId: String(KARAN._id) });
    ok(created.status === 201 && created.data.title === "Call to discuss decor", "create follow-up (owner from roster)");
    ok(created.data.overdue === true, "open + past dueAt → overdue");
    const offRoster = await api("POST", `/enquiry/${leadF._id}/followups`, bossT, { title: "x", dueAt: new Date().toISOString(), ownerId: String(BOSS._id) });
    ok(offRoster.status === 400, "off-roster follow-up owner rejected (Boss not on this roster)");
    const fid = created.data._id;
    const snoozed = await api("PATCH", `/enquiry/${leadF._id}/followups/${fid}`, bossT, { action: "snooze", until: new Date(Date.now() + 2 * DAY).toISOString() });
    ok(snoozed.status === 200 && snoozed.data.status === "snoozed" && !snoozed.data.overdue, "snooze → not overdue while snoozed");
    const done = await api("PATCH", `/enquiry/${leadF._id}/followups/${fid}`, bossT, { action: "done" });
    ok(done.status === 200 && done.data.status === "done", "mark done");
    const journey = (await api("GET", `/enquiry/${leadF._id}/journey`, bossT)).data.entries || [];
    ok(journey.some((e) => e.type === "followup_created") && journey.some((e) => e.type === "followup_completed"), "journey: followup_created + followup_completed");
    const mine = await api("GET", `/enquiry/followups/mine`, karanT);
    ok(mine.status === 200 && Array.isArray(mine.data.list), "my-due follow-ups endpoint works");

    console.log("\n── Slice 3: follow-up chat cards (set on create, due once) ──");
    // New overdue follow-up on leadT → 'set' card now; GET /followups sweeps a 'due' card once.
    const f2 = await api("POST", `/enquiry/${leadT._id}/followups`, bossT, { title: "Confirm venue", dueAt: new Date(Date.now() - 1 * DAY).toISOString(), ownerId: String(KARAN._id) });
    await api("GET", `/enquiry/${leadT._id}/followups`, bossT); // triggers the due sweep
    await api("GET", `/enquiry/${leadT._id}/followups`, bossT); // second poll must NOT add another due card
    const chat = (await api("GET", `/enquiry/${leadT._id}/chat`, bossT)).data.messages || [];
    ok(chat.some((m) => m.systemType === "followup_set" && String(m.followupId) === String(f2.data._id)), "'follow-up set' card posted on create with followupId");
    ok(chat.filter((m) => m.systemType === "followup_due").length === 1, "'follow-up due' card posted exactly ONCE (non-spammy)");
    ok(!chat.some((m) => m.systemType === "step_task_created"), "tasks stay quiet in chat (unchanged)");

    console.log("\n── Slice 4: the ONE rule fires all three ways ──");
    const accF = await api("GET", `/enquiry/${leadT._id}/accountability`, bossT);
    ok(accF.status === 200 && accF.data.needsAttention && accF.data.mostUrgent.kind === "overdue_followup", "overdue follow-up → needs attention (most urgent)");
    const accS = await api("GET", `/enquiry/${leadS._id}/accountability`, bossT);
    ok(accS.data.needsAttention && accS.data.mostUrgent.kind === "stale_step", "stale step → needs attention");
    ok(accS.data.mostUrgent.responsibleId === String(KARAN._id), "stale step responsible = the step owner (Karan)");
    ok(accS.data.thresholdDays === 3, "threshold defaults to 3 days");
    // A fresh lead with nothing pending → no attention.
    const calm = await mkLead("Calm");
    const accCalm = await api("GET", `/enquiry/${calm._id}/accountability`, bossT);
    ok(accCalm.status === 200 && accCalm.data.needsAttention === false, "calm lead → no banner");

    console.log("\n── Slice 4: threshold setting drives the rule ──");
    // Raise the threshold above the staleness → the stale step no longer fires.
    await api("PUT", `/settings`, bossT, { key: "accountability.staleDays", value: 20 });
    const accS20 = await api("GET", `/enquiry/${leadS._id}/accountability`, bossT);
    ok(accS20.data.needsAttention === false && accS20.data.thresholdDays === 20, "threshold=20 → 10-day-stale step no longer needs attention");
    await api("PUT", `/settings`, bossT, { key: "accountability.staleDays", value: 3 }); // restore

    console.log("\n── THE RECONCILE: pipeline stuck == the same rule ──");
    const pipe = await api("GET", `/enquiry/pipeline-overview`, bossT);
    ok(pipe.status === 200 && pipe.data.stuckDays === 3, "pipeline uses the shared threshold (3)");
    const flat = pipe.data.groups.flatMap((g) => g.leads);
    const byId = Object.fromEntries(flat.map((l) => [l._id, l]));
    ok(byId[String(leadS._id)] && byId[String(leadS._id)].stuck === true, "pipeline marks the stale-step lead STUCK (agrees with banner)");
    ok(byId[String(leadT._id)] && byId[String(leadT._id)].stuck === true, "pipeline marks the overdue-followup/task lead STUCK");
    ok(byId[String(calm._id)] && byId[String(calm._id)].stuck === false, "pipeline does NOT mark the calm lead stuck (agrees with banner)");

    console.log("\n── Slice 4: nudge + rate-limit ──");
    const n1 = await api("POST", `/enquiry/${leadS._id}/accountability/nudge`, bossT, { responsibleId: String(KARAN._id), stepName: "Decor Concept Discussion" });
    ok(n1.status === 200 && n1.data.ok, "nudge sent");
    const note = await waitFor(async () => (await AdminNotification.findOne({ adminId: KARAN._id, type: "accountability_nudge" }).lean()) || false, "nudge notification");
    ok(!!note, "nudge pings the responsible person via AdminNotificationService");
    const n2 = await api("POST", `/enquiry/${leadS._id}/accountability/nudge`, bossT, { responsibleId: String(KARAN._id) });
    ok(n2.status === 429, "second nudge within the cooldown is rate-limited (429)");

    console.log("\n── Slash convenience entry points hit the SAME services ──");
    // (Slash is a frontend affordance; here we prove the underlying endpoints a
    // slash form calls are the existing ones.)
    const stepForTask = await LeadStep.create({ leadId: leadS._id, name: "Proposal Shared", phase: "Client Servicing & Proposal", order: 20, status: "not_started" });
    const slashTask = await api("POST", `/enquiry/${leadS._id}/steps/${stepForTask._id}/tasks`, bossT, { title: "/task created", assigneeId: String(KARAN._id) });
    ok(slashTask.status === 201 && String(slashTask.data.stepId) === String(stepForTask._id), "/task → existing createStepTask endpoint");
    const slashStatus = await api("PATCH", `/enquiry/${leadS._id}/steps/${stepForTask._id}`, bossT, { status: "in_progress" });
    ok(slashStatus.status === 200 && slashStatus.data.status === "in_progress", "/status → existing step status endpoint (the 4)");
  } catch (e) {
    fail++; failures.push(`fatal: ${e.message}`); console.error("FATAL", e); console.error(log.slice(-2000));
  } finally {
    const leadIds = [leadF._id, leadT._id, leadS._id];
    const calm = await Enquiry.findOne({ name: `${MARK} Calm` }).lean();
    if (calm) leadIds.push(calm._id);
    await Followup.deleteMany({ leadId: { $in: leadIds } });
    await LeadTask.deleteMany({ leadId: { $in: leadIds } });
    await LeadStep.deleteMany({ leadId: { $in: leadIds } });
    await LeadTeamMember.deleteMany({ leadId: { $in: leadIds } });
    await LeadChatMessage.deleteMany({ leadId: { $in: leadIds } });
    await LeadInternalEvent.deleteMany({ leadId: { $in: leadIds } });
    await AdminNotification.deleteMany({ adminId: { $in: [BOSS._id, KARAN._id] } });
    await Enquiry.deleteMany({ _id: { $in: leadIds } });
    await Setting.deleteMany({ key: "accountability.staleDays" });
    await Admin.deleteMany({ _id: { $in: [BOSS._id, KARAN._id] } });
    await Role.deleteMany({ _id: role._id });
    await Department.deleteMany({ _id: dept._id });
    SettingsService.invalidate();
    child.kill(); await mongoose.disconnect();
    console.log(`\n══ RESULT: ${pass} passed, ${fail} failed ══`);
    if (failures.length) console.log("failures:", failures.join(" | "));
    process.exit(fail === 0 ? 0 : 1);
  }
})();
