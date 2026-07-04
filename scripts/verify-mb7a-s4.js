/* MB7a Slice 4 — onboard flow + lock flag + leads:onboard RBAC. Port 8139. */
require("dotenv").config();
const { spawn } = require("child_process");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const PORT = 8139; const BASE = `http://localhost:${PORT}`; const MARK = "MB7A-S4";
let pass = 0, fail = 0; const failures = [];
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; failures.push(l); console.error(`  ✗ ${l}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, l, t = 30000) => { const u = Date.now() + t; while (Date.now() < u) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(300); } throw new Error(`waitFor: ${l}`); };

(async () => {
  await mongoose.connect(process.env.DATABASE_URL);
  const Admin = require("../models/Admin"); const Role = require("../models/Role"); const Department = require("../models/Department");
  const User = require("../models/User"); const Enquiry = require("../models/Enquiry"); const Event = require("../models/Event");
  const Onboarding = require("../models/Onboarding"); const LeadInternalEvent = require("../models/LeadInternalEvent");

  const PHONE = `9198${String(Date.now()).slice(-8)}`;
  const dept = await Department.create({ name: `${MARK} Dept` });
  const rhRole = await Role.create({ name: `${MARK} RH`, departmentId: dept._id, permissions: ["leads:view:all", "leads:onboard:all"] });
  const internRole = await Role.create({ name: `${MARK} Intern`, departmentId: dept._id, permissions: ["leads:view:own"] });
  const rh = await Admin.create({ name: `${MARK} RH`, email: `s4-rh-${Date.now()}@test.local`, phone: "919800000001", password: "x", roleId: rhRole._id, departmentId: dept._id, status: "active" });
  const intern = await Admin.create({ name: `${MARK} Intern`, email: `s4-in-${Date.now()}@test.local`, phone: "919800000002", password: "x", roleId: internRole._id, departmentId: dept._id, status: "active" });
  const user = await User.create({ name: "S4 Couple", phone: PHONE });
  const other = await User.create({ name: "S4 Other", phone: `9198${String(Date.now() + 1).slice(-8)}` });
  const lead = await Enquiry.create({ name: "S4 Couple", phone: PHONE, verified: false, source: "Website", stage: "meeting_scheduled", additionalInfo: {} });
  const event = await Event.create({ user: user._id, name: "S4 Wedding", community: "Hindu", eventDate: "2026-12-12", eventDays: [{ name: "W", date: "2026-12-12", time: "18:00", venue: "X" }], amount: { total: 1000000, due: 1000000, paid: 0 }, status: { finalized: true, approved: true } });
  const rhTok = jwt.sign({ _id: String(rh._id), isAdmin: true }, process.env.JWT_SECRET);
  const inTok = jwt.sign({ _id: String(intern._id), isAdmin: true }, process.env.JWT_SECRET);
  const uTok = jwt.sign({ _id: String(user._id) }, process.env.JWT_SECRET);
  const oTok = jwt.sign({ _id: String(other._id) }, process.env.JWT_SECRET);

  const child = spawn("node", ["server.js"], { cwd: `${__dirname}/..`, env: { ...process.env, PORT: String(PORT), GOOGLE_SHEETS_KEY_PATH: "/nonexistent/s4.json" }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const api = async (m, p, t, b) => { const r = await fetch(`${BASE}${p}`, { method: m, headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(b ? { "Content-Type": "application/json" } : {}) }, body: b ? JSON.stringify(b) : undefined }); let d = null; try { d = await r.json(); } catch (_) {} return { status: r.status, data: d }; };

  try {
    await waitFor(() => fetch(`${BASE}/`).then((r) => r.ok).catch(() => false), "boot");

    console.log("\n── leads:onboard RBAC ──");
    const denied = await api("POST", "/onboarding/start", inTok, { leadId: String(lead._id), eventId: String(event._id) });
    ok(denied.status === 403, "intern (no leads:onboard) → 403");
    ok((await Onboarding.countDocuments({ leadId: lead._id })) === 0, "no onboarding created on denied attempt");

    console.log("\n── Revenue Head onboards ──");
    const start = await api("POST", "/onboarding/start", rhTok, { leadId: String(lead._id), eventId: String(event._id) });
    ok(start.status === 200, "Revenue Head start → 200");
    ok(start.data.onboarding.lockActive === true, "client dashboard lock active");
    ok(start.data.onboarding.milestones && start.data.onboarding.milestones.advance === 250000, "milestones snapshotted (advance 250000 of 10L)");
    ok(!!(await waitFor(async () => LeadInternalEvent.findOne({ leadId: lead._id, type: "onboarding_started" }).lean(), "onboarding_started")), "journey onboarding_started recorded");

    console.log("\n── Client lock flag (wedsy-user contract) ──");
    const st = await api("GET", `/onboarding/state?eventId=${event._id}`, uTok);
    ok(st.status === 200 && st.data.onboardingLockActive === true && st.data.onboarded === false, "client reads onboardingLockActive true, onboarded false");
    const foreign = await api("GET", `/onboarding/state?eventId=${event._id}`, oTok);
    ok(foreign.status === 403, "another user can't read this event's onboarding state (403)");

    console.log("\n── Idempotent restart ──");
    const start2 = await api("POST", "/onboarding/start", rhTok, { leadId: String(lead._id), eventId: String(event._id) });
    ok(start2.status === 200 && (await Onboarding.countDocuments({ leadId: lead._id })) === 1, "re-start is idempotent (single record)");
  } catch (e) {
    fail++; failures.push(`fatal: ${e.message}`); console.error("FATAL", e); console.error(log.slice(-1200));
  } finally {
    await Onboarding.deleteMany({ leadId: lead._id }); await LeadInternalEvent.deleteMany({ leadId: lead._id });
    await Event.deleteMany({ _id: event._id }); await Enquiry.deleteMany({ _id: lead._id });
    await User.deleteMany({ _id: { $in: [user._id, other._id] } });
    await Admin.deleteMany({ _id: { $in: [rh._id, intern._id] } }); await Role.deleteMany({ _id: { $in: [rhRole._id, internRole._id] } }); await Department.deleteMany({ _id: dept._id });
    child.kill(); await mongoose.disconnect();
    console.log(`\n══ RESULT: ${pass} passed, ${fail} failed ══`);
    if (failures.length) console.log("failures:", failures.join(" | "));
    process.exit(fail === 0 ? 0 : 1);
  }
})();
