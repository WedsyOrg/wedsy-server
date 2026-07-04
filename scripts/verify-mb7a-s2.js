/* MB7a Slice 2 — milestone settings (/config OnboardingMilestones) + math + RBAC.
 * Test port 8137. Cleans up. Run: node scripts/verify-mb7a-s2.js
 */
require("dotenv").config();
const { spawn } = require("child_process");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const PORT = 8137; const BASE = `http://localhost:${PORT}`; const MARK = "MB7A-S2";
let pass = 0, fail = 0; const failures = [];
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; failures.push(l); console.error(`  ✗ ${l}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, l, t = 30000) => { const u = Date.now() + t; while (Date.now() < u) { try { if (await fn()) return; } catch (_) {} await sleep(300); } throw new Error(`waitFor: ${l}`); };

(async () => {
  await mongoose.connect(process.env.DATABASE_URL);
  const Admin = require("../models/Admin"); const Role = require("../models/Role"); const Department = require("../models/Department"); const Config = require("../models/Config");
  const dept = await Department.create({ name: `${MARK} Dept` });
  const founderRole = await Role.create({ name: `${MARK} Founder`, departmentId: dept._id, permissions: ["settings_onboarding:edit:all"] });
  const internRole = await Role.create({ name: `${MARK} Intern`, departmentId: dept._id, permissions: ["leads:view:own"] });
  const founder = await Admin.create({ name: `${MARK} F`, email: `s2-f-${Date.now()}@test.local`, phone: "919600000001", password: "x", roleId: founderRole._id, departmentId: dept._id, status: "active" });
  const intern = await Admin.create({ name: `${MARK} I`, email: `s2-i-${Date.now()}@test.local`, phone: "919600000002", password: "x", roleId: internRole._id, departmentId: dept._id, status: "active" });
  const fTok = jwt.sign({ _id: String(founder._id), isAdmin: true }, process.env.JWT_SECRET);
  const iTok = jwt.sign({ _id: String(intern._id), isAdmin: true }, process.env.JWT_SECRET);
  const cfgBefore = await Config.findOne({ code: "OnboardingMilestones" }).lean();

  const child = spawn("node", ["server.js"], { cwd: `${__dirname}/..`, env: { ...process.env, PORT: String(PORT), GOOGLE_SHEETS_KEY_PATH: "/nonexistent/s2.json" }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const api = async (m, p, t, b) => { const r = await fetch(`${BASE}${p}`, { method: m, headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(b ? { "Content-Type": "application/json" } : {}) }, body: b ? JSON.stringify(b) : undefined }); let d = null; try { d = await r.json(); } catch (_) {} return { status: r.status, data: d }; };

  try {
    await waitFor(() => fetch(`${BASE}/`).then((r) => r.ok).catch(() => false), "boot");

    console.log("\n── Defaults + units ──");
    // Remove any stored row so defaults apply in this run.
    await Config.deleteMany({ code: "OnboardingMilestones" });
    const def = await api("GET", "/onboarding/milestones", iTok);
    ok(def.status === 200 && def.data.onboardingFee === 25000 && def.data.advancePercent === 25 && def.data.balanceDaysBeforeEvent === 14, "defaults: fee 25000, advance 25%, balance 14d");

    console.log("\n── Math (preview) ──");
    const prev = await api("GET", "/onboarding/milestones/preview?total=1000000", iTok);
    // advance = 25% of 10L = 250000; onboardingFee 25000 counts toward it →
    // advanceRemaining 225000; balance = 750000. Units rupees.
    ok(prev.data.advance === 250000 && prev.data.onboardingFee === 25000 && prev.data.advanceRemaining === 225000 && prev.data.balance === 750000, `math correct (adv ${prev.data.advance}, rem ${prev.data.advanceRemaining}, bal ${prev.data.balance})`);
    ok(prev.data.unit === "rupees" && prev.data.currency === "INR", "amounts are rupees/INR");

    console.log("\n── RBAC on PUT ──");
    const denied = await api("PUT", "/onboarding/milestones", iTok, { onboardingFee: 30000, advancePercent: 30, balanceDaysBeforeEvent: 10 });
    ok(denied.status === 403, "admin without settings_onboarding → 403");
    const bad = await api("PUT", "/onboarding/milestones", fTok, { onboardingFee: 30000, advancePercent: 500, balanceDaysBeforeEvent: 10 });
    ok(bad.status === 400, "invalid advancePercent (500) → 400");

    console.log("\n── PUT + persistence ──");
    const put = await api("PUT", "/onboarding/milestones", fTok, { onboardingFee: 30000, advancePercent: 30, balanceDaysBeforeEvent: 10 });
    ok(put.status === 200, "founder PUT → 200");
    const after = await api("GET", "/onboarding/milestones", iTok);
    ok(after.data.onboardingFee === 30000 && after.data.advancePercent === 30 && after.data.balanceDaysBeforeEvent === 10, "GET reflects the saved values");
    const row = await Config.findOne({ code: "OnboardingMilestones" }).lean();
    ok(!!row && row.data.advancePercent === 30, "stored in Config under OnboardingMilestones");
  } catch (e) {
    fail++; failures.push(`fatal: ${e.message}`); console.error("FATAL", e); console.error(log.slice(-1200));
  } finally {
    await Config.deleteMany({ code: "OnboardingMilestones" });
    if (cfgBefore) await Config.create({ code: cfgBefore.code, data: cfgBefore.data });
    await Admin.deleteMany({ _id: { $in: [founder._id, intern._id] } });
    await Role.deleteMany({ _id: { $in: [founderRole._id, internRole._id] } });
    await Department.deleteMany({ _id: dept._id });
    child.kill(); await mongoose.disconnect();
    console.log(`\n══ RESULT: ${pass} passed, ${fail} failed ══`);
    if (failures.length) console.log("failures:", failures.join(" | "));
    process.exit(fail === 0 ? 0 : 1);
  }
})();
