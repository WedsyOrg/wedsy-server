/* MB7a Slice 6 — auto-invoice on payment record + client-downloadable PDF.
 * Port 8141. Cleans up. */
require("dotenv").config();
const { spawn } = require("child_process");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const PORT = 8141; const BASE = `http://localhost:${PORT}`; const MARK = "MB7A-S6";
let pass = 0, fail = 0; const failures = [];
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; failures.push(l); console.error(`  ✗ ${l}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, l, t = 30000) => { const u = Date.now() + t; while (Date.now() < u) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(300); } throw new Error(`waitFor: ${l}`); };

(async () => {
  await mongoose.connect(process.env.DATABASE_URL);
  const Admin = require("../models/Admin"); const Role = require("../models/Role"); const Department = require("../models/Department");
  const User = require("../models/User"); const Enquiry = require("../models/Enquiry"); const Event = require("../models/Event");
  const Onboarding = require("../models/Onboarding"); const LeadInternalEvent = require("../models/LeadInternalEvent"); const Payment = require("../models/Payment");

  const PHONE = `9196${String(Date.now()).slice(-8)}`;
  const dept = await Department.create({ name: `${MARK} Dept` });
  const rhRole = await Role.create({ name: `${MARK} RH`, departmentId: dept._id, permissions: ["leads:onboard:all", "leads:view:all"] });
  const rh = await Admin.create({ name: `${MARK} RH`, email: `s6-rh-${Date.now()}@test.local`, phone: "919600000001", password: "x", roleId: rhRole._id, departmentId: dept._id, status: "active" });
  const user = await User.create({ name: "S6 Couple", phone: PHONE });
  const lead = await Enquiry.create({ name: "S6 Couple", phone: PHONE, verified: false, source: "Website", stage: "meeting_scheduled", additionalInfo: {} });
  const event = await Event.create({ user: user._id, name: "S6 Wedding", community: "Hindu", eventDate: "2026-12-12", eventDays: [{ name: "W", date: "2026-12-12", time: "18:00", venue: "X", decorItems: [], packages: [], customItems: [], mandatoryItems: [] }], amount: { total: 1000000, due: 1000000, paid: 0 }, status: { finalized: true, approved: true } });
  await Onboarding.create({ leadId: lead._id, eventId: event._id, status: "started", lockActive: true, milestones: { onboardingFee: 25000, advancePercent: 25, advance: 250000, advanceRemaining: 225000, balance: 750000, balanceDaysBeforeEvent: 14, total: 1000000, unit: "rupees", currency: "INR" } });
  const rhTok = jwt.sign({ _id: String(rh._id), isAdmin: true }, process.env.JWT_SECRET);
  const uTok = jwt.sign({ _id: String(user._id) }, process.env.JWT_SECRET);

  const child = spawn("node", ["server.js"], { cwd: `${__dirname}/..`, env: { ...process.env, PORT: String(PORT), GOOGLE_SHEETS_KEY_PATH: "/nonexistent/s6.json", RAZORPAY_KEY_ID: "", RAZORPAY_KEY_SECRET: "" }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const api = async (m, p, t, b) => { const r = await fetch(`${BASE}${p}`, { method: m, headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(b ? { "Content-Type": "application/json" } : {}) }, body: b ? JSON.stringify(b) : undefined }); let d = null; try { d = await r.json(); } catch (_) {} return { status: r.status, data: d }; };

  try {
    await waitFor(() => fetch(`${BASE}/`).then((r) => r.ok).catch(() => false), "boot");

    console.log("\n── Auto-invoice on payment record ──");
    const paid = await api("POST", "/onboarding/payment/offline", rhTok, { leadId: String(lead._id), eventId: String(event._id), milestone: "advance", amountRupees: 225000, method: "bank-transfer", txnId: "T6", proofUrl: "https://s3.example.com/p6.jpg" });
    ok(paid.status === 200 && paid.data.invoicePath === `/payment/${paid.data.paymentId}/invoice`, "record returns invoicePath (auto-trigger)");
    const payDoc = await Payment.findById(paid.data.paymentId).lean();
    ok(!!payDoc.invoiceReadyAt, "invoiceReadyAt stamped on the payment");

    console.log("\n── Client downloads the invoice PDF ──");
    const res = await fetch(`${BASE}/payment/${paid.data.paymentId}/invoice`, { headers: { Authorization: `Bearer ${uTok}` } });
    const ct = res.headers.get("content-type") || "";
    const buf = Buffer.from(await res.arrayBuffer());
    ok(res.status === 200 && ct.includes("application/pdf"), `GET /payment/:id/invoice → 200 application/pdf (got ${res.status}, ${ct})`);
    ok(buf.length > 800 && buf.slice(0, 4).toString() === "%PDF", "response is a real PDF (%PDF header, non-trivial size)");
  } catch (e) {
    fail++; failures.push(`fatal: ${e.message}`); console.error("FATAL", e); console.error(log.slice(-1500));
  } finally {
    await Payment.deleteMany({ user: user._id }); await Onboarding.deleteMany({ leadId: lead._id }); await LeadInternalEvent.deleteMany({ leadId: lead._id });
    await Event.deleteMany({ user: user._id }); await Enquiry.deleteMany({ _id: lead._id }); await User.deleteMany({ _id: user._id });
    await Admin.deleteMany({ _id: rh._id }); await Role.deleteMany({ _id: rhRole._id }); await Department.deleteMany({ _id: dept._id });
    child.kill(); await mongoose.disconnect();
    console.log(`\n══ RESULT: ${pass} passed, ${fail} failed ══`);
    if (failures.length) console.log("failures:", failures.join(" | "));
    process.exit(fail === 0 ? 0 : 1);
  }
})();
