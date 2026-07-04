/* Verify widened source acceptance on /webhook/ad-leads: any facebook_* /
 * instagram_* campaign label is accepted, registered, and lowercased; the known
 * set + default still work; junk is still 400. Boots the real server on a TEST
 * port, no external APIs. Cleans up. Run: node scripts/verify-adleads-source-widen.js
 */
require("dotenv").config();
const { spawn } = require("child_process");
const mongoose = require("mongoose");

const PHONE_PREFIX = "9194000";
const MARK = "ADWIDEN";
const PORT = 8135;
const BASE = `http://localhost:${PORT}`;

let pass = 0, fail = 0;
const failures = [];
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; failures.push(label); console.error(`  ✗ ${label}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, label, t = 30000) => {
  const until = Date.now() + t;
  while (Date.now() < until) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(300); }
  throw new Error(`waitFor timed out: ${label}`);
};

(async () => {
  await mongoose.connect(process.env.DATABASE_URL);
  const Enquiry = require("../models/Enquiry");
  const LeadSource = require("../models/LeadSource");
  const Admin = require("../models/Admin");
  const Role = require("../models/Role");
  const Department = require("../models/Department");
  const Setting = require("../models/Setting");

  const dept = await Department.create({ name: `${MARK} Dept` });
  const internRole = await Role.create({ name: `${MARK} Intern`, departmentId: dept._id, permissions: ["leads:view:own"] });
  const intern = await Admin.create({ name: `${MARK} Intern`, email: `aw-i-${Date.now()}@test.local`, phone: "919400000002", password: "x", roleId: internRole._id, departmentId: dept._id, status: "active" });
  const settingsBefore = await Setting.find({ key: "assignment.poolRoles" }).lean();
  await Setting.updateOne({ key: "assignment.poolRoles" }, { $set: { key: "assignment.poolRoles", value: [`${MARK} Intern`] } }, { upsert: true });
  const lsBefore = new Set((await LeadSource.find({}, { title: 1 }).lean()).map((s) => s.title));

  const child = spawn("node", ["server.js"], {
    cwd: `${__dirname}/..`,
    env: { ...process.env, PORT: String(PORT), GOOGLE_SHEETS_KEY_PATH: "/nonexistent/aw.json" }, // AD_LEADS_INTAKE_SECRET unset → open
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));

  const post = async (body) => {
    const res = await fetch(`${BASE}/webhook/ad-leads`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status };
  };
  const ph = (n) => `${PHONE_PREFIX}${String(n).padStart(4, "0")}`;

  try {
    await waitFor(() => fetch(`${BASE}/`).then((r) => r.ok).catch(() => false), "server boot");

    console.log("\n── Campaign labels accepted + registered + lowercased ──");
    const cases = [
      { n: 1, source: "facebook_general", stored: "facebook_general" },
      { n: 2, source: "facebook_june_decor", stored: "facebook_june_decor" },
      { n: 3, source: "instagram_promo", stored: "instagram_promo" },
      { n: 4, source: "Facebook_June", stored: "facebook_june" }, // lowercased
      { n: 5, source: "facebook", stored: "facebook" }, // bare still works
      { n: 6, source: "instagram", stored: "instagram" },
    ];
    for (const c of cases) {
      const r = await post({ name: `Lead ${c.n}`, phone: ph(c.n), source: c.source, city: "Bengaluru" });
      ok(r.status === 201, `source "${c.source}" → 201`);
      const lead = await waitFor(async () => Enquiry.findOne({ phone: ph(c.n) }).lean(), `lead ${c.n} created`);
      ok(lead.source === c.stored, `stored source = "${c.stored}" (got "${lead.source}")`);
      ok(!!(await LeadSource.findOne({ title: c.stored }).lean()), `"${c.stored}" registered in LeadSource master`);
      ok(lead.additionalInfo?.adFormAnswers?.city === "Bengaluru", `lead ${c.n} adFormAnswers captured`);
      ok(String(lead.assignedTo) === String(intern._id), `lead ${c.n} assigned`);
    }

    console.log("\n── Junk rejected, default + landing regression intact ──");
    ok((await post({ name: "Junk", phone: ph(20), source: "random_junk" })).status === 400, "random_junk → 400");
    ok((await post({ name: "Junk2", phone: ph(21), source: "myspace_ad" })).status === 400, "myspace_ad → 400");
    ok((await post({ name: "Junk3", phone: ph(22), source: "facebook-dash" })).status === 400, "facebook-dash (hyphen) → 400");
    ok((await Enquiry.countDocuments({ phone: { $in: [ph(20), ph(21), ph(22)] } })) === 0, "rejected sources created no leads");

    const rDef = await post({ name: "Default Lead", phone: ph(23), interestedService: "Decor" }); // no source
    ok(rDef.status === 201, "absent source → 201");
    const defLead = await waitFor(async () => Enquiry.findOne({ phone: ph(23) }).lean(), "default lead created");
    ok(defLead.source === "Ads (Landing Screen)", "absent source → historical default preserved");
    ok(defLead.additionalInfo?.adFormAnswers?.interestedService === "Decor", "landing answers still captured");
  } catch (e) {
    fail++; failures.push(`fatal: ${e.message}`);
    console.error("FATAL", e); console.error("log tail:", log.slice(-1200));
  } finally {
    await Enquiry.deleteMany({ phone: { $regex: `^${PHONE_PREFIX}` } });
    const createdTitles = ["facebook", "instagram", "facebook_general", "facebook_june_decor", "facebook_june", "instagram_promo", "Ads (Landing Screen)"].filter((t) => !lsBefore.has(t));
    if (createdTitles.length) await LeadSource.deleteMany({ title: { $in: createdTitles } });
    await Admin.deleteMany({ _id: intern._id });
    await Role.deleteMany({ _id: internRole._id });
    await Department.deleteMany({ _id: dept._id });
    await Setting.deleteMany({ key: "assignment.poolRoles" });
    if (settingsBefore.length) await Setting.insertMany(settingsBefore.map(({ _id, ...rest }) => rest));
    child.kill(); await mongoose.disconnect();
    console.log(`\n══ RESULT: ${pass} passed, ${fail} failed ══`);
    if (failures.length) console.log("failures:", failures.join(" | "));
    process.exit(fail === 0 ? 0 : 1);
  }
})();
