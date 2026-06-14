/* MB7b Slice 4 — Nurture v2: library CRUD (founder-gated), WhatsApp-group gate
 * at G-Meet close (Yes→nurture on + task; No→red flag + manager notify),
 * one-tap flip, tasks only when group=true, tick→nurture_touch+clock reset+
 * next task, overdue→CS+Revenue Manager escalation, couple inbound resets the
 * clock. Ports 8153 (server) + 8157 (mock Anthropic for draft text). */
require("dotenv").config();
process.env.ANTHROPIC_API_URL = "http://localhost:8157/v1/messages";
process.env.ANTHROPIC_API_KEY = "test-key";
const { spawn } = require("child_process");
const http = require("http");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const PORT = 8153; const MOCK_PORT = 8157; const BASE = `http://localhost:${PORT}`; const MARK = "MB7B-S4";
const DAY = 86400000;
let pass = 0, fail = 0; const failures = [];
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; failures.push(l); console.error(`  ✗ ${l}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, l, t = 30000) => { const u = Date.now() + t; while (Date.now() < u) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(300); } throw new Error(`waitFor: ${l}`); };

const mock = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ content: [{ type: "text", text: "Hi Arjun & Meera! Quick nurture check-in from Wedsy." }] }));
  });
});

(async () => {
  await mongoose.connect(process.env.DATABASE_URL);
  const Admin = require("../models/Admin"); const Role = require("../models/Role"); const Department = require("../models/Department");
  const Enquiry = require("../models/Enquiry"); const CalendarEvent = require("../models/CalendarEvent");
  const LeadTask = require("../models/LeadTask"); const NurtureTemplate = require("../models/NurtureTemplate");
  const LeadInternalEvent = require("../models/LeadInternalEvent"); const AdminNotification = require("../models/AdminNotification");
  const NurtureService = require("../services/NurtureService"); const LeadTaskService = require("../services/LeadTaskService");
  const SettingsService = require("../services/SettingsService");

  await new Promise((r) => mock.listen(MOCK_PORT, r));
  const dept = await Department.create({ name: `${MARK} Dept` });
  const founderRole = await Role.create({ name: `${MARK} Founder`, departmentId: dept._id, permissions: ["leads:view:all", "leads:edit:all", "settings_nurture:edit:all"] });
  const ownRole = await Role.create({ name: `${MARK} Own`, departmentId: dept._id, permissions: ["leads:view:own", "leads:edit:own"] });
  const csmRole = await Role.create({ name: "CS Manager", departmentId: dept._id, permissions: ["leads:view:all"] });
  const rvmRole = await Role.create({ name: "Revenue Manager", departmentId: dept._id, permissions: ["leads:view:all"] });
  const ph = (s) => `9194${String(Date.now()).slice(-7)}${s}`;
  const F = await Admin.create({ name: `${MARK} F`, email: `s4f-${Date.now()}@t.local`, phone: ph(1), password: "x", roleIds: [founderRole._id], departmentId: dept._id, status: "active" });
  const P = await Admin.create({ name: `${MARK} P`, email: `s4p-${Date.now()}@t.local`, phone: ph(2), password: "x", roleIds: [ownRole._id], departmentId: dept._id, status: "active" });
  const CSM = await Admin.create({ name: `${MARK} CSM`, email: `s4csm-${Date.now()}@t.local`, phone: ph(3), password: "x", roleIds: [csmRole._id], departmentId: dept._id, status: "active" });
  const RVM = await Admin.create({ name: `${MARK} RVM`, email: `s4rvm-${Date.now()}@t.local`, phone: ph(4), password: "x", roleIds: [rvmRole._id], departmentId: dept._id, status: "active" });
  const tok = (a) => jwt.sign({ _id: String(a._id), isAdmin: true }, process.env.JWT_SECRET);
  const fT = tok(F), pT = tok(P);

  const mkLead = () => Enquiry.create({ name: "Nurture Couple", phone: `919${String(Date.now()).slice(-9)}`, verified: false, source: "Website", stage: "won", assignedTo: F._id, qualificationData: { groomName: "Arjun", brideName: "Meera" }, additionalInfo: {} });
  const lead1 = await mkLead(); const lead2 = await mkLead(); const lead3 = await mkLead();

  const child = spawn("node", ["server.js"], { cwd: `${__dirname}/..`, env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const api = async (m, p, t, b) => { const r = await fetch(`${BASE}${p}`, { method: m, headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(b ? { "Content-Type": "application/json" } : {}) }, body: b ? JSON.stringify(b) : undefined }); let d = null; try { d = await r.json(); } catch (_) {} return { status: r.status, data: d }; };
  const openNurture = (leadId) => LeadTask.findOne({ leadId, kind: "nurture", status: "open" }).lean();

  try {
    await waitFor(() => fetch(`${BASE}/`).then((r) => r.ok).catch(() => false), "boot");

    console.log("\n── Nurture Library CRUD (founder-gated) ──");
    const denyWrite = await api("POST", `/nurture-templates`, pT, { category: "Greeting", title: "Hi", text: "Hello" });
    ok(denyWrite.status === 403, "non-founder cannot create a library entry (403)");
    const created = await api("POST", `/nurture-templates`, fT, { category: "Milestones", title: "1 month to go", text: "One month left! Let's finalize.", link: "https://wedsy.in" });
    ok(created.status === 201 && created.data.category === "Milestones", "founder creates a library entry");
    const updated = await api("PUT", `/nurture-templates/${created.data._id}`, fT, { title: "30 days to go" });
    ok(updated.status === 200 && updated.data.title === "30 days to go", "founder updates a library entry");
    const listed = await api("GET", `/nurture-templates`, pT);
    ok(listed.status === 200 && listed.data.list.length >= 1, "any admin can read the library (CS picks copy)");
    const del = await api("DELETE", `/nurture-templates/${created.data._id}`, fT);
    ok(del.status === 200, "founder deletes a library entry");

    console.log("\n── WhatsApp-group gate at G-Meet close: YES ──");
    const gm1 = await CalendarEvent.create({ ownerId: F._id, type: "gmeet", leadId: lead1._id, title: `G-Meet — ${lead1.name}`, start: new Date(Date.now() - DAY), end: new Date(Date.now() - DAY + 3600000), status: "scheduled" });
    const close1 = await api("POST", `/calendar/events/${gm1._id}/close`, fT, { notes: "Great meeting, aligned on scope", whatsappGroupCreated: true });
    ok(close1.status === 200, "G-Meet closes with notes + group=Yes");
    const l1 = await Enquiry.findById(lead1._id).lean();
    ok(l1.whatsappGroupCreated === true && l1.nurture.active === true, "Yes → whatsappGroupCreated + nurture switched on");
    ok((await LeadInternalEvent.countDocuments({ leadId: lead1._id, type: "wa_group_created" })) === 1, "wa_group_created journey recorded");
    const nt1 = await waitFor(() => openNurture(lead1._id), "first nurture task");
    ok(nt1 && nt1.kind === "nurture" && nt1.nurtureText && String(nt1.assigneeId) === String(F._id), "first nurture task created on the CS owner WITH ready-to-copy text");
    const due = nt1.dueAt.getTime() - Date.now();
    ok(due > 1.5 * DAY && due < 2.5 * DAY, "task due ~cadence (2 days) ahead");

    console.log("\n── WhatsApp-group gate at G-Meet close: NO → red flag ──");
    const gm2 = await CalendarEvent.create({ ownerId: F._id, type: "gmeet", leadId: lead2._id, title: `G-Meet — ${lead2.name}`, start: new Date(Date.now() - DAY), end: new Date(Date.now() - DAY + 3600000), status: "scheduled" });
    const close2 = await api("POST", `/calendar/events/${gm2._id}/close`, fT, { notes: "Met, group not made yet", whatsappGroupCreated: false });
    ok(close2.status === 200, "G-Meet closes with group=No");
    const l2 = await Enquiry.findById(lead2._id).lean();
    ok(l2.whatsappGroupFlag.raised === true && l2.whatsappGroupCreated === false && !l2.nurture.active, "No → red flag raised, nurture stays off");
    const flagNotif = await AdminNotification.find({ type: "wa_group_missing", leadId: lead2._id }).lean();
    const recips = new Set(flagNotif.map((n) => String(n.adminId)));
    ok(recips.has(String(F._id)) && recips.has(String(CSM._id)) && recips.has(String(RVM._id)), "owner + CS Manager + Revenue Manager all notified of the missing group");
    ok(!(await openNurture(lead2._id)), "no nurture task while group=false");

    console.log("\n── One-tap flip No → Yes ──");
    const flip = await api("POST", `/enquiry/${lead2._id}/whatsapp-group`, fT, { created: true });
    ok(flip.status === 200, "one-tap flip to Yes accepted");
    const l2b = await Enquiry.findById(lead2._id).lean();
    ok(l2b.whatsappGroupCreated === true && l2b.whatsappGroupFlag.raised === false && l2b.nurture.active === true, "flip clears the flag + switches nurture on");
    ok(await waitFor(() => openNurture(lead2._id), "nurture task after flip"), "nurture task created after the flip");

    console.log("\n── Tasks only when group=true ──");
    const none = await NurtureService.scheduleNurtureTask(lead3._id);
    ok(none === null && !(await openNurture(lead3._id)), "lead without a group → no nurture task scheduled");

    console.log("\n── Tick → nurture_touch + clock reset + next task ──");
    const before = await Enquiry.findById(lead1._id).lean();
    await sleep(10);
    const tick = await api("PUT", `/lead-tasks/${nt1._id}/complete`, fT);
    ok(tick.status === 200 && tick.data.status === "done", "CS ticks the nurture task done");
    ok((await LeadInternalEvent.countDocuments({ leadId: lead1._id, type: "nurture_touch" })) >= 1, "nurture_touch journey recorded");
    const after = await Enquiry.findById(lead1._id).lean();
    ok(new Date(after.nurture.lastTouchAt) > new Date(before.nurture.lastTouchAt), "cadence clock (lastTouchAt) reset");
    const next = await waitFor(() => openNurture(lead1._id), "next nurture task");
    ok(next && String(next._id) !== String(nt1._id), "a fresh rolling nurture task is scheduled");

    console.log("\n── Overdue nurture → CS + Revenue Manager escalation ──");
    await LeadTask.updateOne({ _id: next._id }, { $set: { dueAt: new Date(Date.now() - DAY), overdueEscalatedAt: null } });
    const esc = await LeadTaskService.escalateOverdue(new Date());
    ok(esc.escalated >= 1, "overdue nurture task escalated");
    const csmN = await AdminNotification.countDocuments({ adminId: CSM._id, type: "nurture_overdue" });
    const rvmN = await AdminNotification.countDocuments({ adminId: RVM._id, type: "nurture_overdue" });
    ok(csmN >= 1 && rvmN >= 1, "CS Manager + Revenue Manager notified of the overdue touch");

    console.log("\n── Couple inbound resets the clock ──");
    await LeadTask.updateOne({ _id: next._id }, { $set: { dueAt: new Date(Date.now() + 3600000) } });
    const touchesBefore = await LeadInternalEvent.countDocuments({ leadId: lead1._id, type: "nurture_touch" });
    await NurtureService.registerInboundTouch(lead1._id);
    const reset = await LeadTask.findById(next._id).lean();
    const dd = reset.dueAt.getTime() - Date.now();
    ok(dd > 1.5 * DAY && dd < 2.5 * DAY, "open nurture task pushed forward ~cadence on inbound (don't nag)");
    ok((await LeadInternalEvent.countDocuments({ leadId: lead1._id, type: "nurture_touch" })) === touchesBefore + 1, "couple inbound recorded as a nurture_touch");

    console.log("\n── Cadence config ──");
    ok((await SettingsService.get("nurture.cadenceDays")) === 2, "nurture.cadenceDays defaults to 2 (founder-configurable)");
  } catch (e) {
    fail++; failures.push(`fatal: ${e.message}`); console.error("FATAL", e); console.error(log.slice(-1500));
  } finally {
    const leadIds = [lead1._id, lead2._id, lead3._id];
    await LeadTask.deleteMany({ leadId: { $in: leadIds } }); await CalendarEvent.deleteMany({ leadId: { $in: leadIds } });
    await LeadInternalEvent.deleteMany({ leadId: { $in: leadIds } });
    await NurtureTemplate.deleteMany({ category: { $in: ["Milestones", "Greeting"] } });
    await AdminNotification.deleteMany({ adminId: { $in: [F._id, P._id, CSM._id, RVM._id] } });
    await Enquiry.deleteMany({ _id: { $in: leadIds } });
    await Admin.deleteMany({ _id: { $in: [F._id, P._id, CSM._id, RVM._id] } });
    await Role.deleteMany({ _id: { $in: [founderRole._id, ownRole._id, csmRole._id, rvmRole._id] } });
    await Department.deleteMany({ _id: dept._id });
    child.kill(); mock.close(); await mongoose.disconnect();
    console.log(`\n══ RESULT: ${pass} passed, ${fail} failed ══`);
    if (failures.length) console.log("failures:", failures.join(" | "));
    process.exit(fail === 0 ? 0 : 1);
  }
})();
