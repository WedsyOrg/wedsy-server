/* MB7b Slice 3 — Kiara summary: qualification-trigger + Haiku. A fresh lead
 * makes ZERO model calls; transitioning to qualified makes EXACTLY ONE Haiku
 * call; disqualified/lost leads NEVER call; regenerate works for qualified.
 * A local mock Anthropic endpoint counts calls + records the model. Ports
 * 8152 (server) + 8158 (mock). */
require("dotenv").config();
const { spawn } = require("child_process");
const http = require("http");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const PORT = 8152; const MOCK_PORT = 8158; const BASE = `http://localhost:${PORT}`; const MARK = "MB7B-S3";
let pass = 0, fail = 0; const failures = [];
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; failures.push(l); console.error(`  ✗ ${l}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, l, t = 30000) => { const u = Date.now() + t; while (Date.now() < u) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(300); } throw new Error(`waitFor: ${l}`); };

// Mock Anthropic — records every model used, returns a canned completion.
const calls = [];
const mock = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    try { calls.push(JSON.parse(body || "{}").model || "?"); } catch (_) { calls.push("?"); }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ content: [{ type: "text", text: "MOCK SUMMARY — couple briefing." }] }));
  });
});

(async () => {
  await mongoose.connect(process.env.DATABASE_URL);
  const Admin = require("../models/Admin"); const Role = require("../models/Role"); const Department = require("../models/Department");
  const Enquiry = require("../models/Enquiry");

  await new Promise((r) => mock.listen(MOCK_PORT, r));
  const dept = await Department.create({ name: `${MARK} Dept` });
  const role = await Role.create({ name: `${MARK} All`, departmentId: dept._id, permissions: ["leads:view:all", "leads:edit:all"] });
  const A = await Admin.create({ name: `${MARK} A`, email: `s3a-${Date.now()}@t.local`, phone: `9195${String(Date.now()).slice(-7)}1`, password: "x", roleIds: [role._id], departmentId: dept._id, status: "active" });
  const aT = jwt.sign({ _id: String(A._id), isAdmin: true }, process.env.JWT_SECRET);

  const mkLead = async (extra) => Enquiry.create({ name: "Kiara Couple", phone: `919${String(Date.now()).slice(-9)}`, verified: false, source: "Website", stage: "lead", assignedTo: A._id, qualificationData: { groomName: "Arjun", brideName: "Meera", weddingStyle: "Traditional", servicesRequired: ["Decor"] }, additionalInfo: {}, ...extra });
  const fresh = await mkLead({});
  const disq = await mkLead({ stage: "lost", isLost: true, qualified: true });

  const child = spawn("node", ["server.js"], { cwd: `${__dirname}/..`, env: { ...process.env, PORT: String(PORT), ANTHROPIC_API_URL: `http://localhost:${MOCK_PORT}/v1/messages`, ANTHROPIC_API_KEY: "test-key" }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const api = async (m, p, t, b) => { const r = await fetch(`${BASE}${p}`, { method: m, headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(b ? { "Content-Type": "application/json" } : {}) }, body: b ? JSON.stringify(b) : undefined }); let d = null; try { d = await r.json(); } catch (_) {} return { status: r.status, data: d }; };
  const countFrom = (i) => calls.length - i;

  try {
    await waitFor(() => fetch(`${BASE}/`).then((r) => r.ok).catch(() => false), "boot");

    console.log("\n── Fresh (un-qualified) lead → NO model call ──");
    let i = calls.length;
    const freshGet = await api("GET", `/enquiry/${fresh._id}/kiara-summary`, aT);
    ok(freshGet.status === 200 && freshGet.data.pending === true && /after qualification/i.test(freshGet.data.text), "GET on a fresh lead returns the pre-qualification placeholder");
    ok(countFrom(i) === 0, "fresh lead made ZERO Anthropic calls");
    // An un-answered/busy call also must not qualify or generate.
    await api("POST", `/enquiry/${fresh._id}/call-log`, aT, { startedAt: new Date().toISOString(), durationSeconds: 30, connected: true, outcome: "busy" });
    ok(countFrom(i) === 0, "a non-qualifying call still makes ZERO calls");

    console.log("\n── Transition to qualified → EXACTLY ONE Haiku call ──");
    i = calls.length;
    const qualCall = await api("POST", `/enquiry/${fresh._id}/call-log`, aT, { startedAt: new Date().toISOString(), durationSeconds: 120, connected: true, outcome: "qualified" });
    ok(qualCall.status === 200, "qualified call logged");
    await waitFor(() => countFrom(i) >= 1, "summary call fired");
    ok(countFrom(i) === 1, "qualification triggered EXACTLY ONE call");
    ok(/haiku/i.test(calls[calls.length - 1]), `the summary used the Haiku model (got: ${calls[calls.length - 1]})`);
    const leadAfter = await Enquiry.findById(fresh._id).lean();
    ok(leadAfter.kiaraSummary && leadAfter.kiaraSummary.text === "MOCK SUMMARY — couple briefing.", "summary cached onto the lead");

    console.log("\n── Re-qualify is a no-op; GET serves cache ──");
    i = calls.length;
    await api("POST", `/enquiry/${fresh._id}/call-log`, aT, { startedAt: new Date().toISOString(), durationSeconds: 60, connected: true, outcome: "qualified" });
    const cachedGet = await api("GET", `/enquiry/${fresh._id}/kiara-summary`, aT);
    ok(cachedGet.data.cached === true && countFrom(i) === 0, "already-qualified lead: no new call (guarded + cache served)");

    console.log("\n── Disqualified / lost lead → NEVER calls ──");
    i = calls.length;
    const disqGet = await api("GET", `/enquiry/${disq._id}/kiara-summary`, aT);
    ok(disqGet.data.blocked === true && /closed/i.test(disqGet.data.text), "GET on a lost lead returns the closed notice");
    const disqRegen = await api("POST", `/enquiry/${disq._id}/kiara-summary`, aT);
    ok(disqRegen.data.blocked === true, "regenerate on a lost lead is blocked");
    ok(countFrom(i) === 0, "lost lead made ZERO calls even with qualified=true");

    console.log("\n── Regenerate works for a qualified lead ──");
    i = calls.length;
    const regen = await api("POST", `/enquiry/${fresh._id}/kiara-summary`, aT);
    await waitFor(() => countFrom(i) >= 1, "regenerate call fired");
    ok(regen.status === 200 && regen.data.cached === false && countFrom(i) === 1 && /haiku/i.test(calls[calls.length - 1]), "regenerate forces exactly one fresh Haiku call");
  } catch (e) {
    fail++; failures.push(`fatal: ${e.message}`); console.error("FATAL", e); console.error(log.slice(-1500));
  } finally {
    await Enquiry.deleteMany({ _id: { $in: [fresh._id, disq._id] } });
    await Admin.deleteMany({ _id: A._id }); await Role.deleteMany({ _id: role._id }); await Department.deleteMany({ _id: dept._id });
    child.kill(); mock.close(); await mongoose.disconnect();
    console.log(`\n══ RESULT: ${pass} passed, ${fail} failed ══`);
    if (failures.length) console.log("failures:", failures.join(" | "));
    process.exit(fail === 0 ? 0 : 1);
  }
})();
