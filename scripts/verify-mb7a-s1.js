/* MB7a Slice 1 — finalise gate: max-3-drafts, two-key (client finalise → wedsy
 * approve → payment unlocks), journey events with actors. Boots the server on a
 * TEST port; no external APIs. Cleans up. Run: node scripts/verify-mb7a-s1.js
 */
require("dotenv").config();
const { spawn } = require("child_process");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const PORT = 8136;
const BASE = `http://localhost:${PORT}`;
const MARK = "MB7A-S1";

let pass = 0, fail = 0; const failures = [];
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; failures.push(l); console.error(`  ✗ ${l}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, l, t = 30000) => { const u = Date.now() + t; while (Date.now() < u) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(300); } throw new Error(`waitFor timed out: ${l}`); };

(async () => {
  await mongoose.connect(process.env.DATABASE_URL);
  const Event = require("../models/Event");
  const User = require("../models/User");
  const Enquiry = require("../models/Enquiry");
  const Admin = require("../models/Admin");
  const Role = require("../models/Role");
  const Department = require("../models/Department");
  const LeadInternalEvent = require("../models/LeadInternalEvent");
  const Payment = require("../models/Payment");
  const OnboardingService = require("../services/OnboardingService");

  // Unique per-run phone (the resolver matches lead↔event by phone; a fixed
  // phone could collide with debris if a prior run crashed before cleanup).
  const PHONE = `9195${String(Date.now()).slice(-8)}`;
  const user = await User.create({ name: "Onboard Couple", phone: PHONE });
  const lead = await Enquiry.create({ name: "Onboard Couple", phone: PHONE, verified: false, source: "Website", stage: "meeting_scheduled", additionalInfo: {} });
  const dept = await Department.create({ name: `${MARK} Dept` });
  const adminRole = await Role.create({ name: `${MARK} Admin`, departmentId: dept._id, permissions: ["*:*:all"] });
  const admin = await Admin.create({ name: `${MARK} Admin`, email: `s1-a-${Date.now()}@test.local`, phone: "919500000009", password: "x", roleId: adminRole._id, departmentId: dept._id, status: "active" });
  const userToken = jwt.sign({ _id: String(user._id) }, process.env.JWT_SECRET);
  const adminToken = jwt.sign({ _id: String(admin._id), isAdmin: true }, process.env.JWT_SECRET);

  const child = spawn("node", ["server.js"], { cwd: `${__dirname}/..`, env: { ...process.env, PORT: String(PORT), GOOGLE_SHEETS_KEY_PATH: "/nonexistent/s1.json" }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const api = async (method, path, token, body) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await res.json(); } catch (_) {}
    return { status: res.status, data };
  };
  const mkEvent = (n) => api("POST", "/event", userToken, { name: `Draft ${n}`, community: "Hindu", eventDay: "Wedding", date: "2026-12-12", time: "18:00", venue: "TBD" });
  const eventIds = [];

  try {
    await waitFor(() => fetch(`${BASE}/`).then((r) => r.ok).catch(() => false), "boot");

    console.log("\n── Max-3-drafts cap ──");
    for (let i = 1; i <= 3; i++) { const r = await mkEvent(i); ok(r.status === 200, `draft ${i} created`); if (r.data?._id) eventIds.push(r.data._id); }
    const fourth = await mkEvent(4);
    ok(fourth.status === 409, `4th draft blocked (got ${fourth.status})`);
    ok((await Event.countDocuments({ user: user._id })) === 3, "only 3 drafts exist");

    console.log("\n── Two-key gate ──");
    const ev = eventIds[0];
    // Payment before finalise/approve → locked.
    const payLocked = await api("POST", "/payment", adminToken, { paymentFor: "event", event: ev, paymentMethod: "cash", amount: 1000, user: String(user._id) });
    ok(payLocked.status === 422, `payment locked before finalise/approve (got ${payLocked.status})`);

    const fin = await api("POST", `/event/${ev}/finalize`, userToken);
    ok(fin.status === 200, "client finalise → 200");
    ok(!!(await waitFor(async () => LeadInternalEvent.findOne({ leadId: lead._id, type: "client_finalised" }).lean(), "client_finalised journey")), "journey client_finalised recorded");

    // Still locked after finalise alone (needs approve too).
    const payHalf = await api("POST", "/payment", adminToken, { paymentFor: "event", event: ev, paymentMethod: "cash", amount: 1000, user: String(user._id) });
    ok(payHalf.status === 422, "payment still locked after finalise only (one key)");

    const appr = await api("POST", `/event/${ev}/approve`, adminToken, { discount: 0 });
    ok(appr.status === 200, "wedsy approve → 200");
    const wevent = await waitFor(async () => LeadInternalEvent.findOne({ leadId: lead._id, type: "wedsy_approved" }).lean(), "wedsy_approved journey");
    ok(!!wevent && String(wevent.actorId) === String(admin._id), "journey wedsy_approved recorded with admin actor");

    console.log("\n── Payment unlocked after both keys ──");
    // The gate boundary: after both keys, paymentUnlocked is true (the full
    // offline/online payment flow is exercised in Slice 5).
    const evDoc = await Event.findById(ev, { status: 1 }).lean();
    ok(OnboardingService.paymentUnlocked(evDoc), "paymentUnlocked(event) true after finalise+approve");
    ok(evDoc.status.finalized && evDoc.status.approved, "event is finalized + approved");
  } catch (e) {
    fail++; failures.push(`fatal: ${e.message}`); console.error("FATAL", e); console.error("log tail:", log.slice(-1500));
  } finally {
    await Event.deleteMany({ user: user._id });
    await Payment.deleteMany({ user: user._id });
    await LeadInternalEvent.deleteMany({ leadId: lead._id });
    await Enquiry.deleteMany({ _id: lead._id });
    await User.deleteMany({ _id: user._id });
    await Admin.deleteMany({ _id: admin._id });
    await Role.deleteMany({ _id: adminRole._id });
    await Department.deleteMany({ _id: dept._id });
    child.kill(); await mongoose.disconnect();
    console.log(`\n══ RESULT: ${pass} passed, ${fail} failed ══`);
    if (failures.length) console.log("failures:", failures.join(" | "));
    process.exit(fail === 0 ? 0 : 1);
  }
})();
