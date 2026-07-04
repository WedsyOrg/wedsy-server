/* Password management + access control verification. Port 8160.
 * Slice 1 self-change · Slice 2 admin-set · Slice 3 disable/enable enforcement.
 * Boots the real server; exercises the real login + CheckAdminLogin paths. */
require("dotenv").config();
const { spawn } = require("child_process");
const mongoose = require("mongoose");

const PORT = 8160; const BASE = `http://localhost:${PORT}`; const MARK = "PWMGMT";
let pass = 0, fail = 0; const failures = [];
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; failures.push(l); console.error(`  ✗ ${l}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, l, t = 30000) => { const u = Date.now() + t; while (Date.now() < u) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(300); } throw new Error(`waitFor: ${l}`); };

(async () => {
  await mongoose.connect(process.env.DATABASE_URL);
  const Admin = require("../models/Admin"); const Role = require("../models/Role"); const Department = require("../models/Department");
  const ActivityLog = require("../models/ActivityLog");
  const { CreateHash } = require("../utils/password");

  const dept = await Department.create({ name: `${MARK} Dept` });
  const founderRole = await Role.create({ name: `${MARK} Founder`, departmentId: dept._id, permissions: ["*:*:all"] });
  const mgrRole = await Role.create({ name: `${MARK} Manager`, departmentId: dept._id, permissions: ["team:manage_access:all", "leads:view:all"] });
  const memberRole = await Role.create({ name: `${MARK} Member`, departmentId: dept._id, permissions: ["leads:view:own"] });
  const OLD = "OldPass123";
  const mk = async (label, role) => Admin.create({ name: `${MARK} ${label}`, email: `pwm-${label.toLowerCase()}-${Date.now()}@test.local`, phone: `9193${String(Date.now()).slice(-6)}${label.length}`, password: await CreateHash(OLD), roleIds: [role._id], departmentId: dept._id, status: "active" });
  const FOUNDER = await mk("Founder", founderRole);
  const MANAGER = await mk("Manager", mgrRole);
  const MEMBER = await mk("Member", memberRole);
  const TARGET = await mk("Target", memberRole);

  const child = spawn("node", ["server.js"], { cwd: `${__dirname}/..`, env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const api = async (m, p, t, b) => { const r = await fetch(`${BASE}${p}`, { method: m, headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(b ? { "Content-Type": "application/json" } : {}) }, body: b ? JSON.stringify(b) : undefined }); let d = null; try { d = await r.json(); } catch (_) {} return { status: r.status, data: d }; };
  const login = async (admin, password) => api("POST", "/auth/admin", null, { email: admin.email, password });

  try {
    await waitFor(() => fetch(`${BASE}/`).then((r) => r.ok).catch(() => false), "boot");
    const mgrLogin = await login(MANAGER, OLD); const mgrTok = mgrLogin.data.token;
    const memberLogin = await login(MEMBER, OLD); const memberTok = memberLogin.data.token;
    const founderLogin = await login(FOUNDER, OLD); const founderTok = founderLogin.data.token;
    ok(mgrTok && memberTok && founderTok, "baseline: all admins log in with the seeded password");

    console.log("\n── Slice 1: self password change ──");
    const wrongCur = await api("POST", "/auth/admin/change-password", memberTok, { currentPassword: "WrongCurrent", newPassword: "BrandNew123" });
    ok(wrongCur.status === 401, "wrong current password → 401");
    const tooShort = await api("POST", "/auth/admin/change-password", memberTok, { currentPassword: OLD, newPassword: "short" });
    ok(tooShort.status === 400, "new password < 8 chars → 400");
    const same = await api("POST", "/auth/admin/change-password", memberTok, { currentPassword: OLD, newPassword: OLD });
    ok(same.status === 400, "new == current → 400");
    const changed = await api("POST", "/auth/admin/change-password", memberTok, { currentPassword: OLD, newPassword: "MemberNew123" });
    ok(changed.status === 200, "self change succeeds with correct current");
    ok((await login(MEMBER, OLD)).status === 401, "old password no longer works");
    ok((await login(MEMBER, "MemberNew123")).status === 200, "new password works");
    // Self-only: MEMBER's change did not touch TARGET (no target field exists).
    ok((await login(TARGET, OLD)).status === 200, "another admin's password is untouched (self-only)");

    console.log("\n── Slice 2: admin sets a member's password ──");
    const noPerm = await api("POST", "/admin/set-password", memberTok, { targetAdminId: String(TARGET._id), newPassword: "Hacked123" });
    ok(noPerm.status === 403, "member WITHOUT team:manage_access → 403");
    const shortSet = await api("POST", "/admin/set-password", mgrTok, { targetAdminId: String(TARGET._id), newPassword: "short" });
    ok(shortSet.status === 400, "set-password < 8 → 400");
    const setPw = await api("POST", "/admin/set-password", mgrTok, { targetAdminId: String(TARGET._id), newPassword: "SetByMgr123" });
    ok(setPw.status === 200, "manager WITH permission sets the target's password");
    ok((await login(TARGET, "SetByMgr123")).status === 200, "target logs in with the manager-set password");
    ok((await login(TARGET, OLD)).status === 401, "target's old password no longer works");
    const auditPw = await ActivityLog.findOne({ action: "admin.password_set", entityId: String(TARGET._id) }).lean();
    ok(!!auditPw && String(auditPw.actorId) === String(MANAGER._id), "audit entry written (who set whose password)");
    ok(auditPw && !JSON.stringify(auditPw).includes("SetByMgr123"), "audit entry does NOT contain the password");

    console.log("\n── Slice 3: disable / re-enable enforcement ──");
    const targetTok = (await login(TARGET, "SetByMgr123")).data.token;
    ok(!!targetTok, "target has a live token before disable");
    const memberDisable = await api("POST", "/admin/access", memberTok, { targetAdminId: String(TARGET._id), disabled: true });
    ok(memberDisable.status === 403, "member WITHOUT permission cannot disable → 403");
    const disable = await api("POST", "/admin/access", mgrTok, { targetAdminId: String(TARGET._id), disabled: true });
    ok(disable.status === 200, "manager disables the target");
    ok((await login(TARGET, "SetByMgr123")).status === 403, "disabled admin CANNOT log in → 403");
    const tokenAfterDisable = await api("GET", "/auth/admin/permissions", targetTok);
    ok(tokenAfterDisable.status === 403, "EXISTING token rejected by CheckAdminLogin after disable (immediate cut)");
    const auditDisable = await ActivityLog.findOne({ action: "admin.disabled", entityId: String(TARGET._id) }).lean();
    ok(!!auditDisable && String(auditDisable.actorId) === String(MANAGER._id), "disable audited (who disabled whom)");

    const reenable = await api("POST", "/admin/access", mgrTok, { targetAdminId: String(TARGET._id), disabled: false });
    ok(reenable.status === 200, "manager re-enables the target");
    ok((await login(TARGET, "SetByMgr123")).status === 200, "re-enabled admin can log in again");
    ok(!!(await ActivityLog.findOne({ action: "admin.enabled", entityId: String(TARGET._id) }).lean()), "re-enable audited");

    console.log("\n── Slice 3: safety guards ──");
    const selfDisable = await api("POST", "/admin/access", mgrTok, { targetAdminId: String(MANAGER._id), disabled: true });
    ok(selfDisable.status === 400, "cannot disable yourself → 400");
    const disableFounder = await api("POST", "/admin/access", mgrTok, { targetAdminId: String(FOUNDER._id), disabled: true });
    ok(disableFounder.status === 403, "non-founder cannot disable a founder → 403");
    ok((await login(FOUNDER, OLD)).status === 200, "founder still logs in (was never disabled)");
    // Founder CAN disable a regular member (positive control).
    const founderDisablesMember = await api("POST", "/admin/access", founderTok, { targetAdminId: String(TARGET._id), disabled: true });
    ok(founderDisablesMember.status === 200, "founder can disable a member (positive control)");
    await api("POST", "/admin/access", founderTok, { targetAdminId: String(TARGET._id), disabled: false });

    console.log("\n── Regression: normal admins unaffected ──");
    ok((await login(MANAGER, OLD)).status === 200, "normal admin login still works");
    ok((await api("GET", "/auth/admin/permissions", mgrTok)).status === 200, "auth-protected route works for an enabled admin");
  } catch (e) {
    fail++; failures.push(`fatal: ${e.message}`); console.error("FATAL", e); console.error(log.slice(-1500));
  } finally {
    await ActivityLog.deleteMany({ entityType: "admin", entityId: { $in: [FOUNDER, MANAGER, MEMBER, TARGET].map((a) => String(a._id)) } });
    await Admin.deleteMany({ _id: { $in: [FOUNDER._id, MANAGER._id, MEMBER._id, TARGET._id] } });
    await Role.deleteMany({ _id: { $in: [founderRole._id, mgrRole._id, memberRole._id] } });
    await Department.deleteMany({ _id: dept._id });
    child.kill(); await mongoose.disconnect();
    console.log(`\n══ RESULT: ${pass} passed, ${fail} failed ══`);
    if (failures.length) console.log("failures:", failures.join(" | "));
    process.exit(fail === 0 ? 0 : 1);
  }
})();
