/* MB7a Slice 5 — Razorpay link (dormant), offline-with-proof, ONBOARDED, online
 * confirm, RBAC, rupee units. RAZORPAY keys unset → no live calls. Test users
 * have no email → no real mail. Port 8140. Cleans up. */
require("dotenv").config();
const { spawn } = require("child_process");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const PORT = 8140; const BASE = `http://localhost:${PORT}`; const MARK = "MB7A-S5";
let pass = 0, fail = 0; const failures = [];
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; failures.push(l); console.error(`  ✗ ${l}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, l, t = 30000) => { const u = Date.now() + t; while (Date.now() < u) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(300); } throw new Error(`waitFor: ${l}`); };

(async () => {
  await mongoose.connect(process.env.DATABASE_URL);
  const Admin = require("../models/Admin"); const Role = require("../models/Role"); const Department = require("../models/Department");
  const User = require("../models/User"); const Enquiry = require("../models/Enquiry"); const Event = require("../models/Event");
  const Onboarding = require("../models/Onboarding"); const LeadInternalEvent = require("../models/LeadInternalEvent"); const Payment = require("../models/Payment");

  const mk = async (suffix) => {
    const phone = `9199${String(Date.now()).slice(-7)}${suffix}`;
    const user = await User.create({ name: `S5 ${suffix}`, phone }); // no email → no real mail
    const lead = await Enquiry.create({ name: `S5 ${suffix}`, phone, verified: false, source: "Website", stage: "meeting_scheduled", additionalInfo: {} });
    const event = await Event.create({ user: user._id, name: `S5 ${suffix}`, community: "Hindu", eventDate: "2026-12-12", eventDays: [{ name: "W", date: "2026-12-12", time: "18:00", venue: "X" }], amount: { total: 1000000, due: 1000000, paid: 0 }, status: { finalized: true, approved: true } });
    await Onboarding.create({ leadId: lead._id, eventId: event._id, status: "started", lockActive: true, milestones: { onboardingFee: 25000, advancePercent: 25, advance: 250000, advanceRemaining: 225000, balance: 750000, balanceDaysBeforeEvent: 14, total: 1000000, unit: "rupees", currency: "INR" } });
    return { user, lead, event };
  };

  const dept = await Department.create({ name: `${MARK} Dept` });
  const rhRole = await Role.create({ name: `${MARK} RH`, departmentId: dept._id, permissions: ["leads:onboard:all", "leads:view:all"] });
  const internRole = await Role.create({ name: `${MARK} Intern`, departmentId: dept._id, permissions: ["leads:view:own"] });
  const rh = await Admin.create({ name: `${MARK} RH`, email: `s5-rh-${Date.now()}@test.local`, phone: "919900000001", password: "x", roleId: rhRole._id, departmentId: dept._id, status: "active" });
  const intern = await Admin.create({ name: `${MARK} In`, email: `s5-in-${Date.now()}@test.local`, phone: "919900000002", password: "x", roleId: internRole._id, departmentId: dept._id, status: "active" });
  const rhTok = jwt.sign({ _id: String(rh._id), isAdmin: true }, process.env.JWT_SECRET);
  const inTok = jwt.sign({ _id: String(intern._id), isAdmin: true }, process.env.JWT_SECRET);
  const A = await mk("a"); const B = await mk("b"); const C = await mk("c");

  const child = spawn("node", ["server.js"], { cwd: `${__dirname}/..`, env: { ...process.env, PORT: String(PORT), GOOGLE_SHEETS_KEY_PATH: "/nonexistent/s5.json", RAZORPAY_KEY_ID: "", RAZORPAY_KEY_SECRET: "" }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const api = async (m, p, t, b) => { const r = await fetch(`${BASE}${p}`, { method: m, headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(b ? { "Content-Type": "application/json" } : {}) }, body: b ? JSON.stringify(b) : undefined }); let d = null; try { d = await r.json(); } catch (_) {} return { status: r.status, data: d }; };
  const cleanupLeads = [A.lead._id, B.lead._id, C.lead._id];

  try {
    await waitFor(() => fetch(`${BASE}/`).then((r) => r.ok).catch(() => false), "boot");

    console.log("\n── Razorpay link DORMANT (keys unset) ──");
    const link = await api("POST", "/onboarding/payment-link", rhTok, { leadId: String(A.lead._id), eventId: String(A.event._id), milestone: "onboarding" });
    ok(link.status === 200 && link.data.dormant === true && link.data.mode === "dormant", "payment-link dormant when keys unset (no live call)");
    ok(link.data.amountRupees === 25000 && link.data.amountPaise === 2500000, "onboarding link amount = ₹25000 (2,500,000 paise)");
    const linkPay = await Payment.findById(link.data.paymentId).lean();
    ok(linkPay && linkPay.milestone === "onboarding" && linkPay.amount === 2500000 && linkPay.status === "created", "payment row created (milestone, paise, status)");

    console.log("\n── RBAC ──");
    const denied = await api("POST", "/onboarding/payment-link", inTok, { leadId: String(A.lead._id), eventId: String(A.event._id), milestone: "onboarding" });
    ok(denied.status === 403, "intern (no leads:onboard) → 403 on payment-link");

    console.log("\n── Offline-with-proof + mandatory screenshot ──");
    const noProof = await api("POST", "/onboarding/payment/offline", rhTok, { leadId: String(A.lead._id), eventId: String(A.event._id), milestone: "onboarding", amountRupees: 25000, method: "bank-transfer" });
    ok(noProof.status === 422, "bank-transfer without proof → 422 (screenshot mandatory)");
    const cashNoProof = await api("POST", "/onboarding/payment/offline", rhTok, { leadId: String(A.lead._id), eventId: String(A.event._id), milestone: "advance", amountRupees: 225000, method: "cash" });
    ok(cashNoProof.status === 200, "cash without proof → 200 (optional for cash)");

    console.log("\n── Onboarding fee offline (with proof) → ONBOARDED ──");
    const paid = await api("POST", "/onboarding/payment/offline", rhTok, { leadId: String(A.lead._id), eventId: String(A.event._id), milestone: "onboarding", amountRupees: 25000, method: "bank-transfer", txnId: "TXN123", proofUrl: "https://s3.example.com/proof.jpg", notes: "NEFT" });
    ok(paid.status === 200 && paid.data.amountPaise === 2500000, "onboarding payment recorded (rupees→paise)");
    const payDoc = await Payment.findById(paid.data.paymentId).lean();
    ok(payDoc.status === "paid" && payDoc.proof.url === "https://s3.example.com/proof.jpg" && payDoc.proof.txnId === "TXN123", "proof image + txnId stored");
    const obA = await waitFor(async () => { const o = await Onboarding.findOne({ leadId: A.lead._id }).lean(); return o && o.status === "onboarded" ? o : null; }, "onboarded");
    ok(obA.status === "onboarded" && obA.lockActive === false && obA.onboardedAt, "ONBOARDED: status onboarded, lock cleared, stamped");
    ok(!!(await LeadInternalEvent.findOne({ leadId: A.lead._id, type: "onboarded" }).lean()), "journey onboarded recorded");
    ok(!!(await LeadInternalEvent.findOne({ leadId: A.lead._id, type: "onboarding_payment_recorded" }).lean()), "journey onboarding_payment_recorded");
    const stA = await api("GET", `/onboarding/state?eventId=${A.event._id}`, jwt.sign({ _id: String(A.user._id) }, process.env.JWT_SECRET));
    ok(stA.data.onboarded === true && stA.data.onboardingLockActive === false, "client state: onboarded true, lock cleared");

    console.log("\n── Online confirm seam → ONBOARDED (lead B) ──");
    const linkB = await api("POST", "/onboarding/payment-link", rhTok, { leadId: String(B.lead._id), eventId: String(B.event._id), milestone: "onboarding" });
    const conf = await api("POST", `/onboarding/payment/${linkB.data.paymentId}/confirm`, rhTok);
    ok(conf.status === 200, "confirm online payment → 200");
    const obB = await waitFor(async () => { const o = await Onboarding.findOne({ leadId: B.lead._id }).lean(); return o && o.status === "onboarded" ? o : null; }, "B onboarded");
    ok(obB.status === "onboarded", "online onboarding-fee confirm marks ONBOARDED");
    const payB = await Payment.findById(linkB.data.paymentId).lean();
    ok(payB.status === "paid", "confirmed payment marked paid");

    console.log("\n── Advance milestone amount (lead C) ──");
    const advC = await api("POST", "/onboarding/payment/offline", rhTok, { leadId: String(C.lead._id), eventId: String(C.event._id), milestone: "advance", amountRupees: 225000, method: "upi", txnId: "UPI1" });
    ok(advC.status === 200 && advC.data.amountPaise === 22500000, "advance offline (₹225000 → 22,500,000 paise)");
    const obC = await Onboarding.findOne({ leadId: C.lead._id }).lean();
    ok(obC.status === "started", "advance payment does NOT onboard (only onboarding fee does)");
  } catch (e) {
    fail++; failures.push(`fatal: ${e.message}`); console.error("FATAL", e); console.error(log.slice(-1500));
  } finally {
    const uids = [A.user._id, B.user._id, C.user._id];
    await Payment.deleteMany({ user: { $in: uids } });
    await Onboarding.deleteMany({ leadId: { $in: cleanupLeads } });
    await LeadInternalEvent.deleteMany({ leadId: { $in: cleanupLeads } });
    await Event.deleteMany({ user: { $in: uids } });
    await Enquiry.deleteMany({ _id: { $in: cleanupLeads } });
    await User.deleteMany({ _id: { $in: uids } });
    await Admin.deleteMany({ _id: { $in: [rh._id, intern._id] } });
    await Role.deleteMany({ _id: { $in: [rhRole._id, internRole._id] } });
    await Department.deleteMany({ _id: dept._id });
    child.kill(); await mongoose.disconnect();
    console.log(`\n══ RESULT: ${pass} passed, ${fail} failed ══`);
    if (failures.length) console.log("failures:", failures.join(" | "));
    process.exit(fail === 0 ? 0 : 1);
  }
})();
