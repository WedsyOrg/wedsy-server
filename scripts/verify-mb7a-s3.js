/* MB7a Slice 3 — e-sign agreement: settings text → /settings/public → accept →
 * stored + journey → mail seam dormant. Test port 8138. Cleans up.
 */
require("dotenv").config();
const { spawn } = require("child_process");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const PORT = 8138; const BASE = `http://localhost:${PORT}`; const MARK = "MB7A-S3";
let pass = 0, fail = 0; const failures = [];
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; failures.push(l); console.error(`  ✗ ${l}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, l, t = 30000) => { const u = Date.now() + t; while (Date.now() < u) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(300); } throw new Error(`waitFor: ${l}`); };

(async () => {
  await mongoose.connect(process.env.DATABASE_URL);
  const Admin = require("../models/Admin"); const Role = require("../models/Role"); const Department = require("../models/Department");
  const User = require("../models/User"); const Enquiry = require("../models/Enquiry");
  const Onboarding = require("../models/Onboarding"); const LeadInternalEvent = require("../models/LeadInternalEvent"); const Setting = require("../models/Setting");
  const MailSvc = require("../services/OnboardingMailService");

  const PHONE = `9197${String(Date.now()).slice(-8)}`;
  const dept = await Department.create({ name: `${MARK} Dept` });
  const founderRole = await Role.create({ name: `${MARK} Founder`, departmentId: dept._id, permissions: ["settings_agreement:edit:all"] });
  const founder = await Admin.create({ name: `${MARK} F`, email: `s3-f-${Date.now()}@test.local`, phone: "919700000001", password: "x", roleId: founderRole._id, departmentId: dept._id, status: "active" });
  const user = await User.create({ name: "S3 Couple", phone: PHONE });
  const lead = await Enquiry.create({ name: "S3 Couple", phone: PHONE, verified: false, source: "Website", stage: "meeting_scheduled", additionalInfo: {} });
  const fTok = jwt.sign({ _id: String(founder._id), isAdmin: true }, process.env.JWT_SECRET);
  const uTok = jwt.sign({ _id: String(user._id) }, process.env.JWT_SECRET);
  const settingsBefore = await Setting.find({ key: { $in: ["agreement.terms", "agreement.version"] } }).lean();

  const child = spawn("node", ["server.js"], { cwd: `${__dirname}/..`, env: { ...process.env, PORT: String(PORT), GOOGLE_SHEETS_KEY_PATH: "/nonexistent/s3.json", MAILJET_API_KEY: "", MAILJET_SECRET_KEY: "" }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const api = async (m, p, t, b) => { const r = await fetch(`${BASE}${p}`, { method: m, headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(b ? { "Content-Type": "application/json" } : {}) }, body: b ? JSON.stringify(b) : undefined }); let d = null; try { d = await r.json(); } catch (_) {} return { status: r.status, data: d }; };

  try {
    await waitFor(() => fetch(`${BASE}/`).then((r) => r.ok).catch(() => false), "boot");

    console.log("\n── Agreement text in Settings + client-readable ──");
    const pub0 = await api("GET", "/onboarding/agreement", uTok); // CLIENT token
    ok(typeof pub0.data.terms === "string" && pub0.data.terms.includes("PLACEHOLDER"), "client reads default placeholder terms via /onboarding/agreement");
    ok(pub0.data.version === "v1", "default agreement.version v1");
    const edit = await api("PUT", "/settings", fTok, { key: "agreement.terms", value: "Wedsy terms v-test: pay milestones, etc." });
    ok(edit.status === 200, "founder edits agreement.terms (settings_agreement gate)");
    await api("PUT", "/settings", fTok, { key: "agreement.version", value: "v2" });
    const pub1 = await api("GET", "/onboarding/agreement", uTok);
    ok(pub1.data.terms.includes("v-test") && pub1.data.version === "v2", "edited terms + version surface to the client");

    console.log("\n── Accept → stored + journey ──");
    const noName = await api("POST", "/onboarding/agreement", uTok, { leadId: String(lead._id) });
    ok(noName.status === 400, "accept without acceptedName → 400");
    const acc = await api("POST", "/onboarding/agreement", uTok, { leadId: String(lead._id), acceptedName: "Aarav Sharma" });
    ok(acc.status === 200 && acc.data.agreement.accepted === true, "client accepts → accepted true");
    ok(acc.data.agreement.agreementVersion === "v2", "acceptance stamps current version (v2)");
    const ob = await Onboarding.findOne({ leadId: lead._id }).lean();
    ok(!!ob && ob.agreement.acceptedName === "Aarav Sharma" && ob.agreement.acceptedAt, "acceptance stored on the onboarding record");
    ok(!!(await waitFor(async () => LeadInternalEvent.findOne({ leadId: lead._id, type: "agreement_signed" }).lean(), "agreement_signed")), "journey agreement_signed recorded");
    const status = await api("GET", `/onboarding?leadId=${lead._id}`, fTok);
    ok(status.data.onboarding && status.data.onboarding.agreement.accepted === true, "OS status reflects acceptance");

    console.log("\n── Mail seam dormant (MAILJET unset) ──");
    // Force-unset in THIS process so we exercise the dormant path (and never
    // send a real email). The seam reads env at call time.
    const savedKey = process.env.MAILJET_API_KEY, savedSecret = process.env.MAILJET_SECRET_KEY;
    delete process.env.MAILJET_API_KEY; delete process.env.MAILJET_SECRET_KEY;
    const mail = await MailSvc.sendAgreementEmail({ to: "couple@example.com", name: "Aarav", termsText: "x", version: "v2" });
    if (savedKey !== undefined) process.env.MAILJET_API_KEY = savedKey;
    if (savedSecret !== undefined) process.env.MAILJET_SECRET_KEY = savedSecret;
    ok(mail.sent === false && mail.reason === "dormant", "agreement email seam is dormant + logs when Mailjet unset (no throw)");
  } catch (e) {
    fail++; failures.push(`fatal: ${e.message}`); console.error("FATAL", e); console.error(log.slice(-1200));
  } finally {
    await Onboarding.deleteMany({ leadId: lead._id });
    await LeadInternalEvent.deleteMany({ leadId: lead._id });
    await Enquiry.deleteMany({ _id: lead._id }); await User.deleteMany({ _id: user._id });
    await Admin.deleteMany({ _id: founder._id }); await Role.deleteMany({ _id: founderRole._id }); await Department.deleteMany({ _id: dept._id });
    await Setting.deleteMany({ key: { $in: ["agreement.terms", "agreement.version"] } });
    if (settingsBefore.length) await Setting.insertMany(settingsBefore.map(({ _id, ...r }) => r));
    child.kill(); await mongoose.disconnect();
    console.log(`\n══ RESULT: ${pass} passed, ${fail} failed ══`);
    if (failures.length) console.log("failures:", failures.join(" | "));
    process.exit(fail === 0 ? 0 : 1);
  }
})();
