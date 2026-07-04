/* MB8a — Lead Team Roster layer. Verifies the append-only roster, the
 * department-grouped people options (multi-department), actor-named journey
 * events, SOFT additive visibility (my-team + notification, NO 403 gating), and
 * full-context (untruncated history for a broad member). Test port 8155. */
require("dotenv").config();
const { spawn } = require("child_process");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const PORT = 8155; const BASE = `http://localhost:${PORT}`; const MARK = "MB8A";
let pass = 0, fail = 0; const failures = [];
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; failures.push(l); console.error(`  ✗ ${l}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, l, t = 30000) => { const u = Date.now() + t; while (Date.now() < u) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(300); } throw new Error(`waitFor: ${l}`); };

(async () => {
  await mongoose.connect(process.env.DATABASE_URL);
  const Admin = require("../models/Admin"); const Role = require("../models/Role"); const Department = require("../models/Department");
  const Enquiry = require("../models/Enquiry"); const LeadTeamMember = require("../models/LeadTeamMember");
  const AdminNotification = require("../models/AdminNotification"); const LeadInternalEvent = require("../models/LeadInternalEvent");

  const sales = await Department.create({ name: `${MARK} Sales` });
  const ops = await Department.create({ name: `${MARK} Operations` });
  const cs = await Department.create({ name: `${MARK} ClientServicing` });

  const ownRoleSales = await Role.create({ name: `${MARK} SalesExec`, departmentId: sales._id, permissions: ["leads:view:own", "leads:edit:own"] });
  const revHeadRole = await Role.create({ name: `${MARK} RevHead`, departmentId: sales._id, permissions: ["leads:view:all", "leads:edit:all"] });
  const opsRole = await Role.create({ name: `${MARK} OpsExec`, departmentId: ops._id, permissions: ["leads:view:own", "leads:edit:own"] });

  const u = (s) => `9197${String(Date.now()).slice(-7)}${s}`;
  const mk = (name, roleIds, departmentId) => Admin.create({ name, email: `${name.replace(/\s/g, "")}-${Date.now()}@t.local`, phone: u(Math.floor(Math.random() * 9)), password: "x", roleIds, departmentId, status: "active" });
  const OWNER = await mk(`${MARK} Owner`, [ownRoleSales._id], sales._id);          // sales lead (owns the lead)
  const REVHEAD = await mk(`${MARK} RevHead`, [revHeadRole._id], sales._id);        // broad manage-team
  const OPS = await mk(`${MARK} OpsPerson`, [opsRole._id], ops._id);                // narrow, will be rostered
  const MULTI = await mk(`${MARK} MultiDept`, [ownRoleSales._id, opsRole._id], sales._id); // two departments

  const tok = (a) => jwt.sign({ _id: String(a._id), isAdmin: true }, process.env.JWT_SECRET);
  const ownerT = tok(OWNER), revT = tok(REVHEAD), opsT = tok(OPS);

  const phone = `9190${String(Date.now()).slice(-8)}`;
  const lead = await Enquiry.create({ name: "Roster Couple", phone, verified: false, source: "Website", stage: "lead", assignedTo: OWNER._id, additionalInfo: {} });

  const child = spawn("node", ["server.js"], { cwd: `${__dirname}/..`, env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const api = async (m, p, t, b) => { const r = await fetch(`${BASE}${p}`, { method: m, headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(b ? { "Content-Type": "application/json" } : {}) }, body: b ? JSON.stringify(b) : undefined }); let d = null; try { d = await r.json(); } catch (_) {} return { status: r.status, data: d }; };

  try {
    await waitFor(() => fetch(`${BASE}/`).then((r) => r.ok).catch(() => false), "boot");

    console.log("\n── Slice 2: people options grouped by department (multi-dept) ──");
    const opt = await api("GET", `/enquiry/${lead._id}/team/options`, ownerT);
    ok(opt.status === 200 && Array.isArray(opt.data.groups), "options returns department groups");
    const byName = Object.fromEntries((opt.data.groups || []).map((g) => [g.departmentName, g.people.map((p) => p._id)]));
    ok((byName[`${MARK} Sales`] || []).includes(String(MULTI._id)), "multi-dept person appears under Sales");
    ok((byName[`${MARK} Operations`] || []).includes(String(MULTI._id)), "multi-dept person appears under Operations (same person, both groups)");
    ok((byName[`${MARK} Operations`] || []).includes(String(OPS._id)), "ops person appears under Operations");

    console.log("\n── Slice 1: add member → current team + actor-named journey ──");
    const add1 = await api("POST", `/enquiry/${lead._id}/team`, ownerT, { personId: String(OPS._id), departmentId: String(ops._id) });
    ok(add1.status === 201 && add1.data.personId === String(OPS._id) && add1.data.active === true, "owner adds ops person → active roster row");
    ok(add1.data.departmentName === `${MARK} Operations`, "serving department captured + denormalized");

    const roster1 = await api("GET", `/enquiry/${lead._id}/team`, ownerT);
    ok(roster1.status === 200 && roster1.data.current.length === 1, "current team has 1 member");

    const journey1 = await api("GET", `/enquiry/${lead._id}/journey`, ownerT);
    const added = (journey1.data.entries || []).find((e) => e.type === "team_member_added");
    ok(!!added, "journey has team_member_added event");
    ok(added && added.actor === `${MARK} Owner`, "journey event actor is the person who added (Owner)");
    ok(added && /Added .*OpsPerson.*Operations.*team/.test(added.title), `journey title names person + department ("${added && added.title}")`);

    console.log("\n── Slice 3: notification + additive my-team (NO 403 gating) ──");
    const note = await waitFor(async () => { const n = await AdminNotification.findOne({ adminId: OPS._id, type: "team_added" }).lean(); return n || false; }, "team_added notification");
    ok(!!note && String(note.leadId) === String(lead._id), "added member receives a team_added notification for this lead");

    const mine = await api("GET", `/enquiry/team/mine`, opsT);
    ok(mine.status === 200 && (mine.data.list || []).some((l) => String(l._id) === String(lead._id)), "ops sees the lead in /team/mine (additive — they don't own it)");

    // SOFT: roster does NOT bypass scope. OPS is own-scope and does NOT own the
    // lead → the scoped single read stays out-of-scope (existing behavior: 404,
    // "does not reveal it exists"). Roster is additive (surfaces via /team/mine),
    // never a scope-bypass; requirePermission is untouched.
    const opsDirect = await api("GET", `/enquiry/${lead._id}`, opsT);
    ok(opsDirect.status === 404, "rostered own-scope non-owner stays out-of-scope on the scoped lead read (404, unchanged) — roster never bypasses scope");

    // NON-rostered broad-permission user can STILL open the lead — no roster gating added.
    const revLead = await api("GET", `/enquiry/${lead._id}`, revT);
    ok(revLead.status === 200, "non-rostered broad-permission user can still open the lead (no 403 gating)");
    const revTeam = await api("GET", `/enquiry/${lead._id}/team`, revT);
    ok(revTeam.status === 200, "non-rostered broad user can read the roster (no 403 gating)");

    console.log("\n── Slice 2: Revenue Head manages a lead they don't own + dup guard ──");
    const add2 = await api("POST", `/enquiry/${lead._id}/team`, revT, { personId: String(MULTI._id), departmentId: String(sales._id) });
    ok(add2.status === 201, "Revenue Head (broad) adds a member to a lead they don't own");
    const dup = await api("POST", `/enquiry/${lead._id}/team`, ownerT, { personId: String(OPS._id), departmentId: String(ops._id) });
    ok(dup.status === 409, "duplicate active membership (same person+dept) is rejected");
    const ambiguous = await api("POST", `/enquiry/${lead._id}/team`, ownerT, { personId: String(MULTI._id) });
    ok(ambiguous.status === 400, "multi-department person without a chosen department → 400");

    console.log("\n── Slice 1: remove keeps history (append-only) ──");
    const beforeRows = await LeadTeamMember.countDocuments({ leadId: lead._id });
    const rm = await api("DELETE", `/enquiry/${lead._id}/team/${add1.data._id}`, ownerT);
    ok(rm.status === 200 && rm.data.active === false && !!rm.data.activeTo, "remove sets activeTo (row closed, not deleted)");
    const afterRows = await LeadTeamMember.countDocuments({ leadId: lead._id });
    ok(beforeRows === afterRows, "row count unchanged after remove → record retained (append-only)");
    const closedRow = await LeadTeamMember.findById(add1.data._id).lean();
    ok(closedRow && closedRow.activeTo && String(closedRow.removedBy) === String(OWNER._id), "closed row keeps removedBy + activeTo");

    const roster2 = await api("GET", `/enquiry/${lead._id}/team`, ownerT);
    ok(roster2.data.current.length === 1 && roster2.data.current[0].personId === String(MULTI._id), "current team reflects removal (only MULTI remains)");
    ok(roster2.data.history.length === 2, "history retains BOTH the removed and active rows");

    // Re-add the removed person → a NEW row (append-only), old row retained.
    const readd = await api("POST", `/enquiry/${lead._id}/team`, ownerT, { personId: String(OPS._id), departmentId: String(ops._id) });
    ok(readd.status === 201 && readd.data._id !== add1.data._id, "re-adding writes a NEW row (append-only), old row untouched");
    const roster3 = await api("GET", `/enquiry/${lead._id}/team`, ownerT);
    ok(roster3.data.history.length === 3, "history now has 3 rows (removed + active + re-added)");

    console.log("\n── Slice 4: full-context — broad member sees untruncated history ──");
    // REVHEAD joined AFTER the lead was created; they must still see the lead's
    // creation event and every team event — nothing truncated by activeFrom.
    const revJourney = await api("GET", `/enquiry/${lead._id}/journey`, revT);
    const types = (revJourney.data.entries || []).map((e) => e.type);
    ok(revJourney.status === 200 && types.includes("created"), "broad member sees the lead's creation event (history not truncated to join time)");
    ok(types.filter((t) => t === "team_member_added").length >= 2, "broad member sees all prior team events");
  } catch (e) {
    fail++; failures.push(`fatal: ${e.message}`); console.error("FATAL", e); console.error(log.slice(-1800));
  } finally {
    await LeadTeamMember.deleteMany({ leadId: lead._id });
    await LeadInternalEvent.deleteMany({ leadId: lead._id });
    await AdminNotification.deleteMany({ adminId: { $in: [OWNER._id, REVHEAD._id, OPS._id, MULTI._id] } });
    await Enquiry.deleteMany({ _id: lead._id });
    await Admin.deleteMany({ _id: { $in: [OWNER._id, REVHEAD._id, OPS._id, MULTI._id] } });
    await Role.deleteMany({ _id: { $in: [ownRoleSales._id, revHeadRole._id, opsRole._id] } });
    await Department.deleteMany({ _id: { $in: [sales._id, ops._id, cs._id] } });
    child.kill(); await mongoose.disconnect();
    console.log(`\n══ RESULT: ${pass} passed, ${fail} failed ══`);
    if (failures.length) console.log("failures:", failures.join(" | "));
    process.exit(fail === 0 ? 0 : 1);
  }
})();
