/* MB10 Org & Access — verifies all 4 slices over HTTP on test port 8166.
 * S1 org chart (tree from reportingManagerId, dept grouping, multi-hat edges + gate).
 * S2 permission matrix (cells reflect stored scopes; edit routes through PUT /role/:id;
 *    founder immutable + protected-not-strippable guardrails; read gate).
 * S3 add/edit person (single + multi-hat union; email-dup; reporting cycle;
 *    only-founder-assigns-Founder; joinedAt).
 * S4 write-route scope sweep (own writes own only; team writes team; founder writes all;
 *    out-of-scope 403; reads unchanged). Self-cleaning. */
require("dotenv").config();
const { spawn } = require("child_process");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const PORT = 8166;
const BASE = `http://localhost:${PORT}`;
const MARK = "MB10V";
let pass = 0, fail = 0; const failures = [];
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; failures.push(l); console.error(`  ✗ ${l}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, l, t = 30000) => { const u = Date.now() + t; while (Date.now() < u) { try { if (await fn()) return true; } catch (_) {} await sleep(300); } throw new Error(`waitFor: ${l}`); };

(async () => {
  await mongoose.connect(process.env.DATABASE_URL);
  const Admin = require("../models/Admin");
  const Role = require("../models/Role");
  const Department = require("../models/Department");
  const Enquiry = require("../models/Enquiry");
  const { CreateHash } = require("../utils/password");

  const created = { admins: [], roles: [], depts: [], leads: [] };
  const u = (n) => `9111${String(Date.now()).slice(-6)}${n}`;
  const pw = await CreateHash("secret123");

  // ── Departments
  const dF = await Department.create({ name: `${MARK} Founders` });
  const dS = await Department.create({ name: `${MARK} Sales` });
  const dO = await Department.create({ name: `${MARK} Ops` });
  created.depts.push(dF._id, dS._id, dO._id);

  // ── Roles (existing vocab only)
  const rFounder = await Role.create({ name: `${MARK} Founder`, departmentId: dF._id, permissions: ["*:*:all"], systemKey: "founder", protected: true });
  const rCrmAdmin = await Role.create({ name: `${MARK} CRM Admin`, departmentId: dF._id, permissions: ["users:*:all", "roles:*:all", "settings:*:all"] });
  const rMgr = await Role.create({ name: `${MARK} Sales Manager`, departmentId: dS._id, permissions: ["leads:view:team", "leads:edit:team", "leads:assign:team"] });
  const rExec = await Role.create({ name: `${MARK} Sales Executive`, departmentId: dS._id, permissions: ["leads:view:own", "leads:edit:own"] });
  const rOps = await Role.create({ name: `${MARK} Ops Exec`, departmentId: dO._id, permissions: ["projects:view:own", "tasks:view:own"] });
  const rProtected = await Role.create({ name: `${MARK} Protected`, departmentId: dS._id, permissions: ["leads:view:own"], protected: true });
  created.roles.push(rFounder._id, rCrmAdmin._id, rMgr._id, rExec._id, rOps._id, rProtected._id);

  // ── Admins (the reporting tree)
  const mk = async (name, roleIds, deptId, mgr) => {
    const a = await Admin.create({ name: `${MARK} ${name}`, email: `${name.toLowerCase()}-${Date.now()}@mb10.local`, phone: u(name.length), password: pw, roles: ["crm"], roleIds, roleId: roleIds[0], departmentId: deptId, reportingManagerId: mgr || null, status: "active" });
    created.admins.push(a._id);
    return a;
  };
  const FOUNDER = await mk("Founder", [rFounder._id], dF._id, null);
  const CRMADMIN = await mk("CrmAdmin", [rCrmAdmin._id], dF._id, FOUNDER._id);
  const MANAGER = await mk("Manager", [rMgr._id], dS._id, FOUNDER._id);
  const EXEC_A = await mk("ExecA", [rExec._id], dS._id, MANAGER._id);
  const EXEC_B = await mk("ExecB", [rExec._id], dS._id, MANAGER._id);
  const OUTSIDER = await mk("Outsider", [rExec._id], dS._id, FOUNDER._id); // not under MANAGER
  const tok = (a) => jwt.sign({ _id: String(a._id), isAdmin: true }, process.env.JWT_SECRET);

  // ── Leads
  const mkLead = async (name, owner) => {
    const l = await Enquiry.create({ name: `${MARK} ${name}`, phone: u(`L${name.length}`), verified: false, source: "Website", stage: "new", assignedTo: owner._id, additionalInfo: {} });
    created.leads.push(l._id);
    return l;
  };
  const leadA = await mkLead("LeadA", EXEC_A);
  const leadB = await mkLead("LeadB", EXEC_B);
  const leadOut = await mkLead("LeadOut", OUTSIDER);

  const child = spawn("node", ["server.js"], { cwd: `${__dirname}/..`, env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const api = async (method, p, token, body) => {
    const r = await fetch(`${BASE}${p}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    let d = null; try { d = await r.json(); } catch (_) {}
    return { status: r.status, data: d };
  };

  try {
    await waitFor(() => fetch(`${BASE}/`).then((r) => r.ok).catch(() => false), "boot");

    console.log("\n── Slice 1: org chart ──");
    const chart = await api("GET", "/org/chart", tok(FOUNDER));
    ok(chart.status === 200, `GET /org/chart 200 for founder (got ${chart.status})`);
    const nodeIds = new Set((chart.data.nodes || []).map((n) => n._id));
    ok(nodeIds.has(String(EXEC_A._id)) && nodeIds.has(String(MANAGER._id)), "chart includes our people");
    const edges = chart.data.edges || [];
    const hasEdge = (from, to, type) => edges.some((e) => e.from === String(from._id) && e.to === String(to._id) && (!type || e.type === type));
    ok(hasEdge(MANAGER, FOUNDER, "primary"), "primary edge MANAGER -> FOUNDER");
    ok(hasEdge(EXEC_A, MANAGER, "primary"), "primary edge EXEC_A -> MANAGER");
    const salesGroup = (chart.data.departments || []).find((d) => d.departmentId === String(dS._id));
    ok(salesGroup && salesGroup.members.some((m) => m._id === String(EXEC_A._id)), "department grouping: EXEC_A under Sales");
    ok((await api("GET", "/org/chart", tok(EXEC_A))).status === 403, "chart gated: EXEC_A (no users:view:all) -> 403");

    // Multi-hat: give EXEC_A a 2nd hat (Ops Exec, reporting to MANAGER) via PUT /admin.
    const hatEdit = await api("PUT", `/admin/${EXEC_A._id}`, tok(FOUNDER), {
      hats: [
        { departmentId: String(dS._id), roleId: String(rExec._id), reportingManagerId: String(MANAGER._id) },
        { departmentId: String(dO._id), roleId: String(rOps._id), reportingManagerId: String(MANAGER._id) },
      ],
    });
    ok(hatEdit.status === 200, `multi-hat PUT /admin 200 (got ${hatEdit.status})`);
    ok((hatEdit.data.roleIds || []).length === 2, `roleIds union = 2 (got ${(hatEdit.data.roleIds || []).length})`);
    ok(String(hatEdit.data.departmentId) === String(dS._id), "primary hat mirrors top-level departmentId (Sales)");
    const chart2 = await api("GET", "/org/chart", tok(FOUNDER));
    const execNode = (chart2.data.nodes || []).find((n) => n._id === String(EXEC_A._id));
    ok(execNode && execNode.hatCount === 2, `EXEC_A renders 2 hats (got ${execNode && execNode.hatCount})`);
    ok((chart2.data.edges || []).some((e) => e.from === String(EXEC_A._id) && e.type === "secondary"), "secondary (dotted) edge for 2nd hat");

    console.log("\n── Slice 2: permission matrix ──");
    const mtx = await api("GET", "/org/permission-matrix", tok(FOUNDER));
    ok(mtx.status === 200, `GET /org/permission-matrix 200 (got ${mtx.status})`);
    const row = (id) => (mtx.data.roles || []).find((r) => r._id === String(id));
    ok(row(rMgr._id) && row(rMgr._id).cells["leads:edit"] === "team", `manager cell leads:edit = team (got ${row(rMgr._id) && row(rMgr._id).cells["leads:edit"]})`);
    ok(row(rExec._id) && row(rExec._id).cells["leads:edit"] === "own", "exec cell leads:edit = own");
    ok(row(rFounder._id) && row(rFounder._id).locked === true, "founder row locked");
    ok(row(rFounder._id) && row(rFounder._id).cells["leads:edit"] === "all", "founder *:*:all reads as 'all' in every cell");
    ok((await api("GET", "/org/permission-matrix", tok(EXEC_A))).status === 403, "matrix gated: EXEC_A (no roles:view:all) -> 403");

    // Edit a cell THROUGH the existing PUT /role/:id (add leads:view:team to exec).
    const editCell = await api("PUT", `/role/${rExec._id}`, tok(FOUNDER), { permissions: ["leads:view:team", "leads:edit:own"] });
    ok(editCell.status === 200, `cell edit via PUT /role/:id 200 (got ${editCell.status})`);
    const mtx2 = await api("GET", "/org/permission-matrix", tok(FOUNDER));
    ok(mtx2.data.roles.find((r) => r._id === String(rExec._id)).cells["leads:view"] === "team", "matrix reflects the edit (leads:view now team)");

    // Guardrails (already enforced by RoleService — confirm via the same path):
    ok((await api("PUT", `/role/${rFounder._id}`, tok(FOUNDER), { permissions: ["leads:view:own"] })).status === 422, "founder role immutable (422) even for founder");
    ok((await api("PUT", `/role/${rProtected._id}`, tok(FOUNDER), { permissions: [] })).status === 403, "protected role cannot be stripped (403)");

    console.log("\n── Slice 3: add / edit person (multi-hat) ──");
    const single = await api("POST", "/admin", tok(FOUNDER), { name: `${MARK} NewSingle`, email: `single-${Date.now()}@mb10.local`, password: "secret123", departmentId: String(dS._id), roleId: String(rExec._id), reportingManagerId: String(MANAGER._id) });
    ok(single.status === 201, `single-hat create 201 (got ${single.status})`);
    if (single.data && single.data._id) created.admins.push(single.data._id);
    ok(single.data && single.data.joinedAt, "joinedAt stamped on create");

    const multi = await api("POST", "/admin", tok(FOUNDER), { name: `${MARK} NewMulti`, email: `multi-${Date.now()}@mb10.local`, password: "secret123", hats: [ { departmentId: String(dS._id), roleId: String(rExec._id), reportingManagerId: String(MANAGER._id) }, { departmentId: String(dO._id), roleId: String(rOps._id), reportingManagerId: String(MANAGER._id) } ] });
    ok(multi.status === 201, `multi-hat create 201 (got ${multi.status})`);
    if (multi.data && multi.data._id) created.admins.push(multi.data._id);
    ok(multi.data && (multi.data.roleIds || []).length === 2 && (multi.data.hats || []).length === 2, "multi-hat: roleIds union = 2, hats = 2");

    const dup = await api("POST", "/admin", tok(FOUNDER), { name: `${MARK} Dup`, email: single.data.email, password: "secret123", departmentId: String(dS._id), roleId: String(rExec._id) });
    ok(dup.status === 409, `email uniqueness -> 409 (got ${dup.status})`);

    // Reporting cycle: make MANAGER report to EXEC_A (who reports to MANAGER) -> cycle.
    const cycle = await api("PUT", `/admin/${MANAGER._id}`, tok(FOUNDER), { reportingManagerId: String(EXEC_A._id) });
    ok(cycle.status === 400, `reporting cycle rejected (400) (got ${cycle.status})`);

    // Only a founder may assign the Founder role. CRM Admin (users:*:all, NOT founder) -> 403.
    const crmGrantsFounder = await api("POST", "/admin", tok(CRMADMIN), { name: `${MARK} Sneaky`, email: `sneaky-${Date.now()}@mb10.local`, password: "secret123", departmentId: String(dF._id), roleId: String(rFounder._id) });
    ok(crmGrantsFounder.status === 403, `non-founder assigning Founder -> 403 (got ${crmGrantsFounder.status})`);
    const founderGrantsFounder = await api("POST", "/admin", tok(FOUNDER), { name: `${MARK} Heir`, email: `heir-${Date.now()}@mb10.local`, password: "secret123", departmentId: String(dF._id), roleId: String(rFounder._id) });
    ok(founderGrantsFounder.status === 201, `founder assigning Founder -> 201 (got ${founderGrantsFounder.status})`);
    if (founderGrantsFounder.data && founderGrantsFounder.data._id) created.admins.push(founderGrantsFounder.data._id);
    ok(single.data && single.data.permissions === undefined, "permissions live on roles, never per-person (no permissions field on admin)");

    console.log("\n── Slice 4: write-route scope sweep ──");
    const setNotes = (lead, who) => api("PUT", `/enquiry/${lead._id}/notes`, tok(who), { notes: `${MARK} touched` });
    ok((await setNotes(leadA, EXEC_A)).status === 200, "EXEC_A writes own lead (leadA) -> 200");
    ok((await setNotes(leadB, EXEC_A)).status === 403, "EXEC_A writes EXEC_B's lead -> 403 (out of scope)");
    ok((await setNotes(leadB, MANAGER)).status === 200, "MANAGER writes team lead (leadB, EXEC_B reports to MANAGER) -> 200");
    ok((await setNotes(leadOut, MANAGER)).status === 403, "MANAGER writes OUTSIDER's lead -> 403 (not in team)");
    ok((await setNotes(leadA, FOUNDER)).status === 200, "FOUNDER writes any lead -> 200 (all scope)");
    // stage + assign routes carry the same gate.
    ok((await api("PUT", `/enquiry/${leadB._id}/stage`, tok(EXEC_A), { stage: "contacted" })).status === 403, "EXEC_A stage on EXEC_B's lead -> 403");
    ok((await api("PUT", `/enquiry/${leadA._id}/stage`, tok(EXEC_A), { stage: "contacted" })).status === 200, "EXEC_A stage on own lead -> 200");
    // A role with NO leads:edit at all (Ops Exec: projects/tasks only) -> 403.
    const opsGuy = await mk("OpsGuy", [rOps._id], dO._id, FOUNDER._id);
    ok((await setNotes(leadA, opsGuy)).status === 403, "Ops Exec (no leads:edit) write -> 403");
    // Reads unchanged — the LIST endpoint is the scope-enforced read path (single
    // GET /:_id was never per-doc scoped; out of MB10's WRITE-only sweep). Confirm
    // EXEC_A's scoped list shows their own lead but not EXEC_B's / OUTSIDER's.
    const execList = await api("GET", `/enquiry?limit=200&search=${MARK}&view=active`, tok(EXEC_A));
    const listIds = new Set((execList.data.list || []).map((l) => String(l._id)));
    ok(execList.status === 200 && listIds.has(String(leadA._id)), "read scoping unchanged: EXEC_A list includes own lead");
    ok(!listIds.has(String(leadB._id)) && !listIds.has(String(leadOut._id)), "read scoping unchanged: EXEC_A list excludes out-of-scope leads");
    const founderList = await api("GET", `/enquiry?limit=200&search=${MARK}&view=active`, tok(FOUNDER));
    const fIds = new Set((founderList.data.list || []).map((l) => String(l._id)));
    ok(fIds.has(String(leadA._id)) && fIds.has(String(leadB._id)) && fIds.has(String(leadOut._id)), "read scoping unchanged: founder list sees all leads");
  } catch (e) {
    fail++; failures.push(`fatal: ${e.message}`); console.error("FATAL", e); console.error(log.slice(-2500));
  } finally {
    await Enquiry.deleteMany({ _id: { $in: created.leads } });
    await Admin.deleteMany({ _id: { $in: created.admins } });
    await Role.deleteMany({ _id: { $in: created.roles } });
    await Department.deleteMany({ _id: { $in: created.depts } });
    child.kill(); await mongoose.disconnect();
    console.log(`\n══ RESULT: ${pass} passed, ${fail} failed ══`);
    if (failures.length) console.log("failures:", failures.join(" | "));
    process.exit(fail === 0 ? 0 : 1);
  }
})();
