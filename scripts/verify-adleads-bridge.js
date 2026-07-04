/* Verify the hardened /webhook/ad-leads Make→OS Meta-lead bridge.
 * Boots the real server on TEST ports (no external APIs touched). Covers:
 * secret auth (set + unset), source whitelist + registration, createLead intake
 * (stage/assignment), adFormAnswers, dedup re-enquiry, source filtering,
 * landing-page regression. Cleans up. Run: node scripts/verify-adleads-bridge.js
 */
require("dotenv").config();
const { spawn } = require("child_process");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const SECRET = "mb-adleads-secret-xyz";
const PHONE_PREFIX = "9193000";
const MARK = "ADLEADS";

let pass = 0, fail = 0;
const failures = [];
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; failures.push(label); console.error(`  ✗ ${label}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, label, t = 30000) => {
  const until = Date.now() + t;
  while (Date.now() < until) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(300); }
  throw new Error(`waitFor timed out: ${label}`);
};

const boot = (port, env) => {
  const child = spawn("node", ["server.js"], {
    cwd: `${__dirname}/..`,
    env: { ...process.env, PORT: String(port), GOOGLE_SHEETS_KEY_PATH: "/nonexistent/al.json", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  return { child, log: () => log };
};
const post = async (base, body, headers = {}) => {
  const res = await fetch(`${base}/webhook/ad-leads`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status };
};

(async () => {
  await mongoose.connect(process.env.DATABASE_URL);
  const Enquiry = require("../models/Enquiry");
  const LeadSource = require("../models/LeadSource");
  const LeadInternalEvent = require("../models/LeadInternalEvent");
  const Admin = require("../models/Admin");
  const Role = require("../models/Role");
  const Department = require("../models/Department");
  const Setting = require("../models/Setting");

  // Assignment pool so afterCreate has someone to assign to.
  const dept = await Department.create({ name: `${MARK} Dept` });
  const founderRole = await Role.create({ name: `${MARK} Founder`, departmentId: dept._id, permissions: ["*:*:all"] });
  const internRole = await Role.create({ name: `${MARK} Intern`, departmentId: dept._id, permissions: ["leads:view:own"] });
  const founder = await Admin.create({ name: `${MARK} Founder`, email: `al-f-${Date.now()}@test.local`, phone: "919300000001", password: "x", roleId: founderRole._id, departmentId: dept._id, status: "active" });
  const intern = await Admin.create({ name: `${MARK} Intern`, email: `al-i-${Date.now()}@test.local`, phone: "919300000002", password: "x", roleId: internRole._id, departmentId: dept._id, status: "active" });
  const founderToken = jwt.sign({ _id: String(founder._id), isAdmin: true }, process.env.JWT_SECRET);
  const settingsBefore = await Setting.find({ key: "assignment.poolRoles" }).lean();
  await Setting.updateOne({ key: "assignment.poolRoles" }, { $set: { key: "assignment.poolRoles", value: [`${MARK} Intern`] } }, { upsert: true });
  // Snapshot existing lead-source titles so cleanup only removes ones we create.
  const lsBefore = new Set((await LeadSource.find({}, { title: 1 }).lean()).map((s) => s.title));

  const A = boot(8133, { AD_LEADS_INTAKE_SECRET: SECRET });
  const B = boot(8134, { AD_LEADS_INTAKE_SECRET: "" }); // unset → open
  const BASE_A = "http://localhost:8133";
  const BASE_B = "http://localhost:8134";

  const ph = (n) => `${PHONE_PREFIX}${String(n).padStart(4, "0")}`;
  const fbLead = (n) => ({
    name: `FB Lead ${n}`, phone: ph(n), email: `fb${n}@example.com`,
    source: "facebook",
    weddingStyle: "South Indian", city: "Bengaluru", budget: "15L", // form answers
  });

  try {
    await waitFor(() => fetch(`${BASE_A}/`).then((r) => r.ok).catch(() => false), "server A boot");
    await waitFor(() => fetch(`${BASE_B}/`).then((r) => r.ok).catch(() => false), "server B boot");

    console.log("\n── Auth (secret set) ──");
    ok((await post(BASE_A, fbLead(1))).status === 401, "missing header → 401");
    ok((await post(BASE_A, fbLead(1), { "x-wedsy-intake-key": "wrong" })).status === 401, "wrong secret → 401");
    const noLeadYet = await Enquiry.countDocuments({ phone: ph(1) });
    ok(noLeadYet === 0, "rejected requests created no lead");

    console.log("\n── Happy path (FB lead) ──");
    const r1 = await post(BASE_A, fbLead(1), { "x-wedsy-intake-key": SECRET });
    ok(r1.status === 201, "correct secret + FB lead → 201");
    const lead1 = await waitFor(async () => Enquiry.findOne({ phone: ph(1) }).lean(), "FB lead created");
    ok(lead1.source === "facebook", `source is facebook (got ${lead1.source})`);
    ok(lead1.stage === "new", "stage pinned to new (Bug-A-safe)");
    ok(lead1.additionalInfo?.adFormAnswers?.weddingStyle === "South Indian", "adFormAnswers populated");
    ok(String(lead1.assignedTo) === String(intern._id), "round-robin assigned to the pool intern");
    ok(lead1.email === "fb1@example.com", "email captured");

    console.log("\n── Source registration + filtering ──");
    ok(!!(await LeadSource.findOne({ title: "facebook" }).lean()), "facebook registered in the lead-source master");
    const filtered = await fetch(`${BASE_A}/enquiry?limit=200&filters=${encodeURIComponent(JSON.stringify([{ field: "source", op: "eq", value: "facebook" }]))}`, { headers: { Authorization: `Bearer ${founderToken}` } });
    const fData = await filtered.json();
    ok(filtered.status === 200 && (fData.list || []).some((l) => String(l._id) === String(lead1._id)), "source filter eq:facebook returns the lead");

    console.log("\n── Dedup → re-enquiry (no duplicate) ──");
    const r2 = await post(BASE_A, { ...fbLead(1), budget: "20L" }, { "x-wedsy-intake-key": SECRET });
    ok(r2.status === 201, "repeat phone → 201");
    await sleep(500);
    ok((await Enquiry.countDocuments({ phone: ph(1) })) === 1, "no duplicate lead on repeat phone");
    ok(!!(await LeadInternalEvent.findOne({ leadId: lead1._id, type: "re_enquired" }).lean()), "re_enquired event recorded");

    console.log("\n── Validation + whitelist ──");
    ok((await post(BASE_A, { name: "X" }, { "x-wedsy-intake-key": SECRET })).status === 400, "missing phone → 400");
    ok((await post(BASE_A, { name: "Y", phone: ph(2), source: "myspace" }, { "x-wedsy-intake-key": SECRET })).status === 400, "unknown source → 400");
    ok((await Enquiry.countDocuments({ phone: ph(2) })) === 0, "rejected unknown-source created no lead");

    console.log("\n── Landing-page regression (no source → default) ──");
    const r3 = await post(BASE_A, { name: "Landing Lead", phone: ph(3), email: "lp@example.com", interestedService: "Decor" }, { "x-wedsy-intake-key": SECRET });
    ok(r3.status === 201, "no-source landing post → 201");
    const lead3 = await waitFor(async () => Enquiry.findOne({ phone: ph(3) }).lean(), "landing lead created");
    ok(lead3.source === "Ads (Landing Screen)", "absent source → historical default preserved");
    ok(lead3.additionalInfo?.adFormAnswers?.interestedService === "Decor", "landing answers still captured");

    console.log("\n── instagram source ──");
    await post(BASE_A, { name: "IG Lead", phone: ph(4), source: "instagram" }, { "x-wedsy-intake-key": SECRET });
    const lead4 = await waitFor(async () => Enquiry.findOne({ phone: ph(4) }).lean(), "IG lead created");
    ok(lead4.source === "instagram", "instagram source accepted");

    console.log("\n── Unset secret → open (pre-config preserved) + warns ──");
    const r5 = await post(BASE_B, { name: "Open Lead", phone: ph(5), source: "facebook" }); // no header
    ok(r5.status === 201, "unset secret + no header → 201 (open)");
    await waitFor(async () => Enquiry.findOne({ phone: ph(5) }).lean(), "open lead created");
    ok(/AD_LEADS_INTAKE_SECRET unset/.test(B.log()), "warns that the endpoint is open when secret unset");
  } catch (e) {
    fail++; failures.push(`fatal: ${e.message}`);
    console.error("FATAL", e);
    console.error("A log tail:", A.log().slice(-1200));
  } finally {
    const leads = await Enquiry.find({ phone: { $regex: `^${PHONE_PREFIX}` } }, { _id: 1 }).lean();
    await LeadInternalEvent.deleteMany({ leadId: { $in: leads.map((l) => l._id) } });
    await Enquiry.deleteMany({ phone: { $regex: `^${PHONE_PREFIX}` } });
    // Only remove lead-source rows this run created (never pre-existing ones).
    const createdTitles = ["facebook", "instagram", "Ads (Landing Screen)", "landing_page"].filter((t) => !lsBefore.has(t));
    if (createdTitles.length) await LeadSource.deleteMany({ title: { $in: createdTitles } });
    await Admin.deleteMany({ _id: { $in: [founder._id, intern._id] } });
    await Role.deleteMany({ _id: { $in: [founderRole._id, internRole._id] } });
    await Department.deleteMany({ _id: dept._id });
    await Setting.deleteMany({ key: "assignment.poolRoles" });
    if (settingsBefore.length) await Setting.insertMany(settingsBefore.map(({ _id, ...rest }) => rest));
    A.child.kill(); B.child.kill();
    await mongoose.disconnect();
    console.log(`\n══ RESULT: ${pass} passed, ${fail} failed ══`);
    if (failures.length) console.log("failures:", failures.join(" | "));
    process.exit(fail === 0 ? 0 : 1);
  }
})();
