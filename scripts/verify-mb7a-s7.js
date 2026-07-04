/* MB7a Slice 7 — RBAC v2 roleIds[] permission UNION (+ back-compat + migration
 * idempotency) and the CS onboarded-clients dashboard + CSV. Port 8142. */
require("dotenv").config();
const { spawn } = require("child_process");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const PORT = 8142; const BASE = `http://localhost:${PORT}`; const MARK = "MB7A-S7";
let pass = 0, fail = 0; const failures = [];
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; failures.push(l); console.error(`  ✗ ${l}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, l, t = 30000) => { const u = Date.now() + t; while (Date.now() < u) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(300); } throw new Error(`waitFor: ${l}`); };

(async () => {
  await mongoose.connect(process.env.DATABASE_URL);
  const Admin = require("../models/Admin"); const Role = require("../models/Role"); const Department = require("../models/Department");
  const User = require("../models/User"); const Enquiry = require("../models/Enquiry"); const Event = require("../models/Event");
  const Onboarding = require("../models/Onboarding"); const Project = require("../models/Project"); const Config = require("../models/Config");

  const dept = await Department.create({ name: `${MARK} Dept` });
  const roleA = await Role.create({ name: `${MARK} A`, departmentId: dept._id, permissions: ["leads:view:all"] });
  const roleB = await Role.create({ name: `${MARK} B`, departmentId: dept._id, permissions: ["settings_onboarding:edit:all"] });
  const csRole = await Role.create({ name: `${MARK} CS`, departmentId: dept._id, permissions: ["projects:view:all"] });
  // M: multi-role (A ∪ B). S: single-role legacy (roleId only, no roleIds). S2: roleIds=[A] only. CS: projects:view:all.
  const M = await Admin.create({ name: `${MARK} M`, email: `s7-m-${Date.now()}@test.local`, phone: "919500000071", password: "x", roleIds: [roleA._id, roleB._id], departmentId: dept._id, status: "active" });
  const S = await Admin.create({ name: `${MARK} S`, email: `s7-s-${Date.now()}@test.local`, phone: "919500000072", password: "x", roleId: roleA._id, departmentId: dept._id, status: "active" });
  const S2 = await Admin.create({ name: `${MARK} S2`, email: `s7-s2-${Date.now()}@test.local`, phone: "919500000073", password: "x", roleIds: [roleA._id], departmentId: dept._id, status: "active" });
  const CS = await Admin.create({ name: `${MARK} CS`, email: `s7-cs-${Date.now()}@test.local`, phone: "919500000074", password: "x", roleIds: [csRole._id], departmentId: dept._id, status: "active" });
  const mTok = jwt.sign({ _id: String(M._id), isAdmin: true }, process.env.JWT_SECRET);
  const sTok = jwt.sign({ _id: String(S._id), isAdmin: true }, process.env.JWT_SECRET);
  const s2Tok = jwt.sign({ _id: String(S2._id), isAdmin: true }, process.env.JWT_SECRET);
  const csTok = jwt.sign({ _id: String(CS._id), isAdmin: true }, process.env.JWT_SECRET);
  const cfgBefore = await Config.findOne({ code: "OnboardingMilestones" }).lean();

  // Onboarded client fixture for the CS dashboard.
  const phone = `9195${String(Date.now()).slice(-8)}`;
  const cuser = await User.create({ name: "CS Couple", phone });
  const clead = await Enquiry.create({ name: "CS Couple", phone, verified: false, source: "Website", stage: "won", additionalInfo: {} });
  const cevent = await Event.create({ user: cuser._id, name: "CS Wedding", community: "Hindu", eventDate: "2026-12-12", eventDays: [{ name: "W", date: "2026-12-12", time: "18:00", venue: "X" }], amount: { total: 1000000 }, status: { finalized: true, approved: true } });
  await Project.create({ leadId: clead._id, coupleNames: "CS Couple", eventIds: [cevent._id], csOwnerId: CS._id, value: 1000000 });
  await Onboarding.create({ leadId: clead._id, eventId: cevent._id, status: "onboarded", onboardedAt: new Date(), milestones: { total: 1000000 }, agreement: { accepted: true } });

  const child = spawn("node", ["server.js"], { cwd: `${__dirname}/..`, env: { ...process.env, PORT: String(PORT), GOOGLE_SHEETS_KEY_PATH: "/nonexistent/s7.json" }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const api = async (m, p, t, b) => { const r = await fetch(`${BASE}${p}`, { method: m, headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(b ? { "Content-Type": "application/json" } : {}) }, body: b ? JSON.stringify(b) : undefined }); let d = null; try { d = await r.json(); } catch (_) {} return { status: r.status, data: d }; };

  try {
    await waitFor(() => fetch(`${BASE}/`).then((r) => r.ok).catch(() => false), "boot");

    console.log("\n── Multi-role permission UNION ──");
    const mPerms = await api("GET", "/auth/admin/permissions", mTok);
    ok(mPerms.data.permissions.includes("leads:view:all") && mPerms.data.permissions.includes("settings_onboarding:edit:all"), "union: permissions from BOTH roles present");
    ok(Array.isArray(mPerms.data.roleNames) && mPerms.data.roleNames.length === 2, "roleNames lists both roles");
    const mPut = await api("PUT", "/onboarding/milestones", mTok, { onboardingFee: 25000, advancePercent: 25, balanceDaysBeforeEvent: 14 });
    ok(mPut.status === 200, "multi-role admin can PUT milestones (settings_onboarding from role B)");

    console.log("\n── Single-role back-compat (roleId only) ──");
    const sPerms = await api("GET", "/auth/admin/permissions", sTok);
    ok(sPerms.data.permissions.includes("leads:view:all") && sPerms.data.permissions.length === 1, "legacy roleId-only admin resolves its role's perms");
    const sPut = await api("PUT", "/onboarding/milestones", sTok, { onboardingFee: 25000, advancePercent: 25, balanceDaysBeforeEvent: 14 });
    ok(sPut.status === 403, "single-role admin without settings_onboarding → 403 (gate still enforces)");

    console.log("\n── roleIds without the perm → 403 ──");
    const s2Put = await api("PUT", "/onboarding/milestones", s2Tok, { onboardingFee: 25000, advancePercent: 25, balanceDaysBeforeEvent: 14 });
    ok(s2Put.status === 403, "roleIds=[A] (no settings_onboarding) → 403");

    console.log("\n── CS dashboard (scoped) + CSV ──");
    const csList = await api("GET", "/onboarding/cs/clients", csTok);
    ok(csList.status === 200 && (csList.data.list || []).some((c) => String(c.leadId) === String(clead._id)), "CS sees the onboarded client in scope");
    const row = (csList.data.list || []).find((c) => String(c.leadId) === String(clead._id));
    ok(row && row.totalRupees === 1000000 && row.agreementAccepted === true, "CS row carries total + agreement status");
    const csCsv = await fetch(`${BASE}/onboarding/cs/clients.csv`, { headers: { Authorization: `Bearer ${csTok}` } });
    const csvText = await csCsv.text();
    ok(csCsv.status === 200 && (csCsv.headers.get("content-type") || "").includes("text/csv") && csvText.includes("CS Couple"), "CSV export downloads with the client row");
    const denied = await api("GET", "/onboarding/cs/clients", sTok); // S has leads:view only, no projects:view
    ok(denied.status === 403, "admin without projects:view → 403 on CS list");

    console.log("\n── Migration idempotency (roleId → roleIds[]) ──");
    const pendingBefore = await Admin.countDocuments({ _id: S._id, $or: [{ roleIds: { $exists: false } }, { roleIds: { $size: 0 } }] });
    ok(pendingBefore === 1, "legacy admin S is pending backfill");
    await Admin.updateOne({ _id: S._id, $or: [{ roleIds: { $exists: false } }, { roleIds: { $size: 0 } }] }, { $set: { roleIds: [S.roleId] } });
    const sAfter = await Admin.findById(S._id).lean();
    ok(sAfter.roleIds.length === 1 && String(sAfter.roleIds[0]) === String(roleA._id), "backfill sets roleIds=[roleId]");
    const pendingAfter = await Admin.countDocuments({ _id: S._id, $or: [{ roleIds: { $exists: false } }, { roleIds: { $size: 0 } }] });
    ok(pendingAfter === 0, "re-run is a no-op (idempotent)");
  } catch (e) {
    fail++; failures.push(`fatal: ${e.message}`); console.error("FATAL", e); console.error(log.slice(-1500));
  } finally {
    await Onboarding.deleteMany({ leadId: clead._id }); await Project.deleteMany({ leadId: clead._id });
    await Event.deleteMany({ user: cuser._id }); await Enquiry.deleteMany({ _id: clead._id }); await User.deleteMany({ _id: cuser._id });
    await Admin.deleteMany({ _id: { $in: [M._id, S._id, S2._id, CS._id] } });
    await Role.deleteMany({ _id: { $in: [roleA._id, roleB._id, csRole._id] } });
    await Department.deleteMany({ _id: dept._id });
    await Config.deleteMany({ code: "OnboardingMilestones" });
    if (cfgBefore) await Config.create({ code: cfgBefore.code, data: cfgBefore.data });
    child.kill(); await mongoose.disconnect();
    console.log(`\n══ RESULT: ${pass} passed, ${fail} failed ══`);
    if (failures.length) console.log("failures:", failures.join(" | "));
    process.exit(fail === 0 ? 0 : 1);
  }
})();
