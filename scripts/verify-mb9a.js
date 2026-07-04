/* MB9a Slices 1-3 — the two-window lifecycle hinge. Verifies phase-gated chat
 * membership (pre-qual = assignee + manager; post-qual = roster), the SINGLE
 * qualify transition (button OR cockpit converge: marks qualified + journey ONCE
 * + ownership handoff to the manager), idempotency, and that chat history is
 * preserved across the transition. Test port 8160. */
require("dotenv").config();
const { spawn } = require("child_process");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const PORT = 8160; const BASE = `http://localhost:${PORT}`; const MARK = "MB9A";
let pass = 0, fail = 0; const failures = [];
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; failures.push(l); console.error(`  ✗ ${l}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, l, t = 30000) => { const u = Date.now() + t; while (Date.now() < u) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(300); } throw new Error(`waitFor: ${l}`); };

(async () => {
  await mongoose.connect(process.env.DATABASE_URL);
  const Admin = require("../models/Admin"); const Role = require("../models/Role"); const Department = require("../models/Department");
  const Enquiry = require("../models/Enquiry"); const LeadStep = require("../models/LeadStep");
  const LeadTeamMember = require("../models/LeadTeamMember"); const LeadChatMessage = require("../models/LeadChatMessage");
  const LeadInternalEvent = require("../models/LeadInternalEvent");
  const StepDefinitionService = require("../services/StepDefinitionService");

  await StepDefinitionService.seed(); // journey definitions must exist to instantiate

  const dept = await Department.create({ name: `${MARK} Dept` });
  const role = await Role.create({ name: `${MARK} All`, departmentId: dept._id, permissions: ["*:*:all"] });
  const u = (s) => `9197${String(Date.now()).slice(-7)}${s}`;
  const mk = (name, mgr) => Admin.create({ name: `${MARK} ${name}`, email: `${name}-${Date.now()}@t.local`, phone: u(Math.floor(Math.random() * 9)), password: "x", roleIds: [role._id], departmentId: dept._id, reportingManagerId: mgr || null, status: "active" });
  const MANAGER = await mk("Manager");
  const INTERN = await mk("Intern", MANAGER._id);     // assignee; reports to MANAGER
  const OPS = await mk("Ops");                          // a roster add post-qual
  const internT = jwt.sign({ _id: String(INTERN._id), isAdmin: true }, process.env.JWT_SECRET);
  const mgrT = jwt.sign({ _id: String(MANAGER._id), isAdmin: true }, process.env.JWT_SECRET);

  // Two pre-qual leads: L1 qualified via the BUTTON, L2 via the COCKPIT path.
  const mkLead = async (n) => Enquiry.create({ name: `${MARK} ${n}`, phone: `9190${String(Date.now()).slice(-7)}${n}`, verified: false, source: "Website", stage: "new", assignedTo: INTERN._id, additionalInfo: {} });
  const L1 = await mkLead("L1"); const L2 = await mkLead("L2");

  const child = spawn("node", ["server.js"], { cwd: `${__dirname}/..`, env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const api = async (m, p, t, b) => { const r = await fetch(`${BASE}${p}`, { method: m, headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(b ? { "Content-Type": "application/json" } : {}) }, body: b ? JSON.stringify(b) : undefined }); let d = null; try { d = await r.json(); } catch (_) {} return { status: r.status, data: d }; };

  try {
    await waitFor(() => fetch(`${BASE}/`).then((r) => r.ok).catch(() => false), "boot");

    console.log("\n── Slice 2: pre-qual chat membership = assignee + manager ──");
    const m1 = await api("GET", `/enquiry/${L1._id}/chat/members`, mgrT);
    const ids1 = (m1.data.list || []).map((x) => String(x._id));
    ok(m1.status === 200 && ids1.length === 2 && ids1.includes(String(INTERN._id)) && ids1.includes(String(MANAGER._id)), "pre-qual chat = the assignee + their reporting manager (2)");
    ok(!ids1.includes(String(OPS._id)), "pre-qual chat excludes everyone else");

    // Post a pre-qual chat message — history must survive the transition.
    await api("POST", `/enquiry/${L1._id}/chat`, internT, { body: "pre-qual intake note" });

    console.log("\n── Slice 3: QUALIFY via the button (assignee or manager) ──");
    const beforeOwner = (await Enquiry.findById(L1._id).lean()).assignedTo;
    ok(String(beforeOwner) === String(INTERN._id), "pre-qual: owned by the intern (assignee)");
    const q = await api("POST", `/enquiry/${L1._id}/qualify`, internT, {});
    ok(q.status === 200 && q.data.lead.qualified === true && q.data.alreadyQualified === false, "qualify button marks the lead qualified");
    ok(q.data.handedOff === true && String(q.data.lead.assignedTo) === String(MANAGER._id), "ownership handed to the sales lead (the intern's manager)");
    const stepCount = await waitFor(async () => { const c = await LeadStep.countDocuments({ leadId: L1._id }); return c > 0 ? c : false; }, "journey instantiated");
    ok(stepCount > 0, `journey BORN at qualify (${stepCount} steps)`);

    console.log("\n── Slice 3: idempotent — re-qualify is a no-op ──");
    const again = await api("POST", `/enquiry/${L1._id}/qualify`, mgrT, {});
    ok(again.status === 200 && again.data.alreadyQualified === true, "re-qualify reports alreadyQualified");
    const stepCount2 = await LeadStep.countDocuments({ leadId: L1._id });
    ok(stepCount2 === stepCount, "journey NOT re-instantiated (no double)");

    console.log("\n── Slice 2: post-qual chat membership = the roster ──");
    // Add OPS to the roster; the chat membership now follows the roster.
    await LeadTeamMember.create({ leadId: L1._id, personId: MANAGER._id, addedBy: MANAGER._id });
    await LeadTeamMember.create({ leadId: L1._id, personId: OPS._id, addedBy: MANAGER._id });
    const m2 = await api("GET", `/enquiry/${L1._id}/chat/members`, mgrT);
    const ids2 = (m2.data.list || []).map((x) => String(x._id));
    ok(ids2.includes(String(MANAGER._id)) && ids2.includes(String(OPS._id)), "post-qual chat = the roster (manager + ops)");
    ok(!ids2.includes(String(INTERN._id)) || ids2.length === 2, "post-qual chat is roster-driven (intern only if on the roster)");

    console.log("\n── Slice 2: chat history preserved across the transition ──");
    const chat = (await api("GET", `/enquiry/${L1._id}/chat`, mgrT)).data.messages || [];
    ok(chat.some((m) => /pre-qual intake note/.test(m.body)), "the pre-qual chat message is still in the thread post-qual");

    console.log("\n── Slice 3: cockpit qualified path converges on the SAME transition ──");
    const beforeOwner2 = (await Enquiry.findById(L2._id).lean()).assignedTo;
    ok(String(beforeOwner2) === String(INTERN._id), "L2 pre-qual owned by the intern");
    const callRes = await api("POST", `/enquiry/${L2._id}/call-log`, internT, { startedAt: new Date().toISOString(), durationSeconds: 120, connected: true, outcome: "qualified" });
    ok(callRes.status === 200, "cockpit qualified call logged");
    const l2 = await waitFor(async () => { const x = await Enquiry.findById(L2._id).lean(); return x.qualified ? x : false; }, "L2 qualified via cockpit");
    ok(l2.qualified === true, "cockpit qualified path marks qualified (same flag)");
    ok(String(l2.assignedTo) === String(MANAGER._id), "cockpit path ALSO hands ownership to the manager (no fork)");
    const l2Steps = await LeadStep.countDocuments({ leadId: L2._id });
    ok(l2Steps > 0, "cockpit path instantiated the journey once");
  } catch (e) {
    fail++; failures.push(`fatal: ${e.message}`); console.error("FATAL", e); console.error(log.slice(-2000));
  } finally {
    const leadIds = [L1._id, L2._id];
    await LeadStep.deleteMany({ leadId: { $in: leadIds } });
    await LeadTeamMember.deleteMany({ leadId: { $in: leadIds } });
    await LeadChatMessage.deleteMany({ leadId: { $in: leadIds } });
    await LeadInternalEvent.deleteMany({ leadId: { $in: leadIds } });
    await Enquiry.deleteMany({ _id: { $in: leadIds } });
    await Admin.deleteMany({ _id: { $in: [MANAGER._id, INTERN._id, OPS._id] } });
    await Role.deleteMany({ _id: role._id });
    await Department.deleteMany({ _id: dept._id });
    child.kill(); await mongoose.disconnect();
    console.log(`\n══ RESULT: ${pass} passed, ${fail} failed ══`);
    if (failures.length) console.log("failures:", failures.join(" | "));
    process.exit(fail === 0 ? 0 : 1);
  }
})();
