/* MB8c-1 — Journey Dashboards. Verifies My Work (caller steps across leads,
 * overdue-first sort, filters, counts, completed-hidden, own/team/all breadth,
 * empty state) and Pipeline Overview (phase grouping, progress, stuck rule,
 * scope all-vs-roster, stuck-only, summary). Test port 8157. */
require("dotenv").config();
const { spawn } = require("child_process");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const PORT = 8157; const BASE = `http://localhost:${PORT}`; const MARK = "MB8C1";
let pass = 0, fail = 0; const failures = [];
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; failures.push(l); console.error(`  ✗ ${l}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, l, t = 30000) => { const u = Date.now() + t; while (Date.now() < u) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(300); } throw new Error(`waitFor: ${l}`); };

(async () => {
  await mongoose.connect(process.env.DATABASE_URL);
  const Admin = require("../models/Admin"); const Role = require("../models/Role"); const Department = require("../models/Department");
  const Enquiry = require("../models/Enquiry"); const LeadStep = require("../models/LeadStep");
  const LeadTeamMember = require("../models/LeadTeamMember");

  const dept = await Department.create({ name: `${MARK} Dept` });
  const ownRole = await Role.create({ name: `${MARK} Own`, departmentId: dept._id, permissions: ["leads:view:own", "leads:edit:own"] });
  const teamRole = await Role.create({ name: `${MARK} Team`, departmentId: dept._id, permissions: ["leads:view:team", "leads:edit:team"] });
  const allRole = await Role.create({ name: `${MARK} All`, departmentId: dept._id, permissions: ["leads:view:all", "leads:edit:all"] });
  const u = (s) => `9197${String(Date.now()).slice(-7)}${s}`;
  const mk = (name, roleIds, mgr) => Admin.create({ name, email: `${name.replace(/\s/g, "")}-${Date.now()}@t.local`, phone: u(Math.floor(Math.random() * 9)), password: "x", roleIds, departmentId: dept._id, reportingManagerId: mgr || null, status: "active" });
  const MANAGER = await mk(`${MARK} Manager`, [teamRole._id]);
  const SUB = await mk(`${MARK} Sub`, [ownRole._id], MANAGER._id);
  const REVHEAD = await mk(`${MARK} RevHead`, [allRole._id]);
  const OUTSIDER = await mk(`${MARK} Outsider`, [ownRole._id]);
  const NOBODY = await mk(`${MARK} Nobody`, [ownRole._id]);
  const tok = (a) => jwt.sign({ _id: String(a._id), isAdmin: true }, process.env.JWT_SECRET);

  const now = Date.now();
  const ph = (n) => ["Lead Understanding", "Client Servicing & Proposal", "Follow Up & Conversion"][n];
  const ln = (s) => `9190${String(now).slice(-8)}${s}`;
  const LeadA = await Enquiry.create({ name: `${MARK} LeadA`, phone: ln(1), verified: false, source: "Website", stage: "lead", assignedTo: SUB._id, additionalInfo: {} });
  const LeadB = await Enquiry.create({ name: `${MARK} LeadB`, phone: ln(2), verified: false, source: "Website", stage: "lead", assignedTo: OUTSIDER._id, additionalInfo: {} });
  const LeadC = await Enquiry.create({ name: `${MARK} LeadC`, phone: ln(3), verified: false, source: "Website", stage: "lead", assignedTo: MANAGER._id, additionalInfo: {} });
  const LeadD = await Enquiry.create({ name: `${MARK} LeadD`, phone: ln(4), verified: false, source: "Website", stage: "lead", assignedTo: MANAGER._id, additionalInfo: {} });

  // Steps. A1 overdue (SUB); A2 blocked on A1 (SUB); B1 due-soon (OUTSIDER);
  // C1 unowned not_started (LeadC, SUB on roster); D1 no-movement (MANAGER).
  const A1 = await LeadStep.create({ leadId: LeadA._id, name: "Review Bigin Notes", phase: ph(0), order: 10, ownerIds: [SUB._id], status: "in_progress", dueAt: new Date(now - 1 * 86400000) });
  const A2 = await LeadStep.create({ leadId: LeadA._id, name: "Internal Team Discussion", phase: ph(0), order: 20, ownerIds: [SUB._id], status: "not_started", dependsOn: [A1._id] });
  const B1 = await LeadStep.create({ leadId: LeadB._id, name: "Negotiation Call", phase: ph(2), order: 10, ownerIds: [OUTSIDER._id], status: "in_progress", dueAt: new Date(now + 2 * 86400000) });
  const C1 = await LeadStep.create({ leadId: LeadC._id, name: "Client Follow Up", phase: ph(1), order: 10, ownerIds: [], status: "not_started" });
  const D1 = await LeadStep.create({ leadId: LeadD._id, name: "Decor Concept Discussion", phase: ph(1), order: 10, ownerIds: [MANAGER._id], status: "in_progress" });
  // D1 has no movement for 10 days (set updatedAt without bumping it).
  await LeadStep.updateOne({ _id: D1._id }, { $set: { updatedAt: new Date(now - 10 * 86400000) } }, { timestamps: false });
  // MB8c-2a-ii reconcile: the pipeline "stuck" flag now uses the SHARED
  // accountability rule (stale in_progress step / overdue follow-up / overdue
  // task) at the shared threshold (3) — overdue STEP DUE-DATE alone no longer
  // makes a lead stuck. Make LeadA stuck the unified way: A1 stale (no movement).
  await LeadStep.updateOne({ _id: A1._id }, { $set: { updatedAt: new Date(now - 10 * 86400000) } }, { timestamps: false });
  // Roster: SUB on LeadA + LeadC; OUTSIDER on LeadB; MANAGER on LeadD.
  await LeadTeamMember.create({ leadId: LeadA._id, personId: SUB._id, addedBy: SUB._id });
  await LeadTeamMember.create({ leadId: LeadC._id, personId: SUB._id, addedBy: MANAGER._id });
  await LeadTeamMember.create({ leadId: LeadB._id, personId: OUTSIDER._id, addedBy: OUTSIDER._id });
  await LeadTeamMember.create({ leadId: LeadD._id, personId: MANAGER._id, addedBy: MANAGER._id });

  const child = spawn("node", ["server.js"], { cwd: `${__dirname}/..`, env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const api = async (m, p, t) => { const r = await fetch(`${BASE}${p}`, { headers: t ? { Authorization: `Bearer ${t}` } : {} }); let d = null; try { d = await r.json(); } catch (_) {} return { status: r.status, data: d }; };
  const ids = (rows) => rows.map((r) => String(r._id));

  try {
    await waitFor(() => fetch(`${BASE}/`).then((r) => r.ok).catch(() => false), "boot");

    console.log("\n── Slice 1: My Work (own scope = SUB) ──");
    const subWork = await api("GET", "/enquiry/steps/my-work", tok(SUB));
    ok(subWork.status === 200, "my-work returns 200");
    const subIds = ids(subWork.data.rows);
    ok(subIds.includes(String(A1._id)) && subIds.includes(String(A2._id)), "SUB sees their owned steps (A1, A2)");
    ok(subIds.includes(String(C1._id)), "SUB sees a roster lead's step they don't own (C1, additive)");
    ok(!subIds.includes(String(B1._id)), "SUB does NOT see another owner's unrelated step (B1)");
    ok(subWork.data.rows[0]._id === String(A1._id), "overdue step sorts first");
    ok(subWork.data.counts.overdue === 1 && subWork.data.counts.blocked === 1, `counts: overdue=1, blocked=1 (got ${subWork.data.counts.overdue}/${subWork.data.counts.blocked})`);
    const a2 = subWork.data.rows.find((r) => r._id === String(A2._id));
    ok(a2 && a2.blocked === true, "A2 flagged blocked (depends on incomplete A1)");

    console.log("\n── Slice 1: filters + completed-hidden ──");
    const fStatus = await api("GET", "/enquiry/steps/my-work?status=not_started", tok(SUB));
    ok(fStatus.data.rows.every((r) => r.status === "not_started"), "status filter");
    const fPhase = await api("GET", `/enquiry/steps/my-work?phase=${encodeURIComponent(ph(0))}`, tok(SUB));
    ok(fPhase.data.rows.every((r) => r.phase === ph(0)) && fPhase.data.rows.length === 2, "phase filter (A1, A2)");
    const fOver = await api("GET", "/enquiry/steps/my-work?overdueOnly=true", tok(SUB));
    ok(fOver.data.rows.length === 1 && fOver.data.rows[0]._id === String(A1._id), "overdueOnly filter");
    await LeadStep.updateOne({ _id: C1._id }, { $set: { status: "complete" } });
    const hidden = await api("GET", "/enquiry/steps/my-work", tok(SUB));
    ok(!ids(hidden.data.rows).includes(String(C1._id)), "completed step hidden by default");
    const shown = await api("GET", "/enquiry/steps/my-work?includeComplete=true", tok(SUB));
    ok(ids(shown.data.rows).includes(String(C1._id)), "completed step shown with includeComplete toggle");
    await LeadStep.updateOne({ _id: C1._id }, { $set: { status: "not_started" } }); // restore

    console.log("\n── Slice 1: scope breadth (own < team < all) ──");
    const mgrWork = await api("GET", "/enquiry/steps/my-work", tok(MANAGER));
    ok(ids(mgrWork.data.rows).includes(String(A1._id)), "MANAGER (team) sees a subordinate's step (A1)");
    const revWork = await api("GET", "/enquiry/steps/my-work", tok(REVHEAD));
    ok(ids(revWork.data.rows).includes(String(B1._id)), "REVHEAD (all) sees an out-of-tree step (B1)");
    ok(!ids(mgrWork.data.rows).includes(String(B1._id)), "MANAGER (team) does NOT see the out-of-tree step (B1) — breadth differs");
    const nobody = await api("GET", "/enquiry/steps/my-work", tok(NOBODY));
    ok(nobody.status === 200 && nobody.data.rows.length === 0 && nobody.data.counts.total === 0, "empty state for an admin with no work");

    console.log("\n── Slice 2: Pipeline Overview (all scope = REVHEAD) ──");
    const pipe = await api("GET", "/enquiry/pipeline-overview", tok(REVHEAD));
    ok(pipe.status === 200 && Array.isArray(pipe.data.groups), "pipeline returns grouped data");
    ok(pipe.data.stuckDays === 3, "stuck rule uses the shared accountability threshold (3)");
    const flat = pipe.data.groups.flatMap((g) => g.leads);
    const byId = Object.fromEntries(flat.map((l) => [l._id, l]));
    const a = byId[String(LeadA._id)], c = byId[String(LeadC._id)], d = byId[String(LeadD._id)];
    ok(a && a.bucket === ph(0), "LeadA grouped under its current journey phase (Lead Understanding)");
    ok(a && a.progress && a.progress.done === 0 && a.progress.total === 2, "LeadA progress 0/2 in current phase");
    ok(a && a.stuck && /no update/.test(a.stuckReason), "LeadA stuck via the stale-step rule (no update)");
    ok(d && d.stuck && /no update/.test(d.stuckReason), "LeadD stuck via the stale-step rule (no update)");
    ok(c && !c.stuck, "LeadC not stuck");
    ok(a && a.team.some((t) => t._id === String(SUB._id)), "LeadA shows its team (SUB)");

    console.log("\n── Slice 2: scope (own = SUB) + stuck-only filter ──");
    const subPipe = await api("GET", "/enquiry/pipeline-overview", tok(SUB));
    const subLeadIds = subPipe.data.groups.flatMap((g) => g.leads).map((l) => l._id);
    ok(subLeadIds.includes(String(LeadA._id)) && subLeadIds.includes(String(LeadC._id)), "SUB pipeline shows their roster leads (A, C)");
    ok(!subLeadIds.includes(String(LeadB._id)) && !subLeadIds.includes(String(LeadD._id)), "SUB pipeline excludes non-roster leads (B, D)");
    const stuckOnly = await api("GET", "/enquiry/pipeline-overview?stuckOnly=true", tok(REVHEAD));
    const stuckIds = stuckOnly.data.groups.flatMap((g) => g.leads).map((l) => l._id);
    ok(stuckIds.includes(String(LeadA._id)) && stuckIds.includes(String(LeadD._id)) && !stuckIds.includes(String(LeadC._id)), "stuck-only filter returns only stuck leads");
    ok(stuckOnly.data.summary.stuck >= 2 && stuckOnly.data.groups.flatMap((g) => g.leads).every((l) => l.stuck), "stuck-only summary + rows all stuck");

    console.log("\n── Slice 2: phase grouping for a member filter ──");
    const memberFilter = await api("GET", `/enquiry/pipeline-overview?memberId=${String(SUB._id)}`, tok(REVHEAD));
    const mfIds = memberFilter.data.groups.flatMap((g) => g.leads).map((l) => l._id);
    ok(mfIds.includes(String(LeadA._id)) && !mfIds.includes(String(LeadD._id)), "memberId filter narrows to that member's leads");
  } catch (e) {
    fail++; failures.push(`fatal: ${e.message}`); console.error("FATAL", e); console.error(log.slice(-2000));
  } finally {
    await LeadStep.deleteMany({ leadId: { $in: [LeadA._id, LeadB._id, LeadC._id, LeadD._id] } });
    await LeadTeamMember.deleteMany({ leadId: { $in: [LeadA._id, LeadB._id, LeadC._id, LeadD._id] } });
    await Enquiry.deleteMany({ _id: { $in: [LeadA._id, LeadB._id, LeadC._id, LeadD._id] } });
    await Admin.deleteMany({ _id: { $in: [MANAGER._id, SUB._id, REVHEAD._id, OUTSIDER._id, NOBODY._id] } });
    await Role.deleteMany({ _id: { $in: [ownRole._id, teamRole._id, allRole._id] } });
    await Department.deleteMany({ _id: dept._id });
    child.kill(); await mongoose.disconnect();
    console.log(`\n══ RESULT: ${pass} passed, ${fail} failed ══`);
    if (failures.length) console.log("failures:", failures.join(" | "));
    process.exit(fail === 0 ? 0 : 1);
  }
})();
