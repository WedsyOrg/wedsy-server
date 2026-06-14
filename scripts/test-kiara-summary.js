/* Slice 5 verify — Kiara AI summary endpoint.
 * Boots the real server on a TEST port with Anthropic pointed at an in-process
 * mock (canned response). Covers: generate→cache, regenerate (force), the
 * empty-data graceful case, and RBAC lead-scope (403 out of scope). Cleans up.
 * Run: node scripts/test-kiara-summary.js
 */
require("dotenv").config();
const http = require("http");
const { spawn } = require("child_process");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const APP_PORT = 8131;
const MOCK_PORT = 8132;
const BASE = `http://localhost:${APP_PORT}`;
const MARK = "KIARA-SUMMARY";

let pass = 0, fail = 0;
const failures = [];
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; failures.push(label); console.error(`  ✗ ${label}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, label, t = 30000) => {
  const until = Date.now() + t;
  while (Date.now() < until) { try { if (await fn()) return; } catch (_) {} await sleep(300); }
  throw new Error(`waitFor timed out: ${label}`);
};

const CANNED = "Aarav & Meera are planning a December South-Indian wedding in Bengaluru, venue still open. They want decor and catering — budget around ₹18L. Next move: lock the venue shortlist on your call.";

const mock = { calls: [] };
const mockServer = http.createServer((req, res) => {
  let raw = ""; req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (req.url === "/v1/messages") {
      mock.calls.push(raw ? JSON.parse(raw) : {});
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "msg_summary", content: [{ type: "text", text: CANNED }], stop_reason: "end_turn" }));
      return;
    }
    res.writeHead(404); res.end();
  });
});

(async () => {
  await mongoose.connect(process.env.DATABASE_URL);
  const Enquiry = require("../models/Enquiry");
  const Admin = require("../models/Admin");
  const Role = require("../models/Role");
  const Department = require("../models/Department");

  const dept = await Department.create({ name: `${MARK} Dept` });
  const ownerRole = await Role.create({ name: `${MARK} Owner`, departmentId: dept._id, permissions: ["leads:view:own", "leads:edit:own"] });
  const owner = await Admin.create({ name: "Summary Owner", email: `ks-owner-${Date.now()}@test.local`, phone: "919900000501", password: "x", roleId: ownerRole._id, departmentId: dept._id, status: "active" });
  const other = await Admin.create({ name: "Summary Other", email: `ks-other-${Date.now()}@test.local`, phone: "919900000502", password: "x", roleId: ownerRole._id, departmentId: dept._id, status: "active" });
  const tok = (a) => jwt.sign({ _id: String(a._id), isAdmin: true }, process.env.JWT_SECRET);
  const ownerToken = tok(owner), otherToken = tok(other);

  const richLead = await Enquiry.create({
    name: "Aarav Sharma", phone: "919900000510", verified: false, source: "Instagram", additionalInfo: { kiaraAnswers: { city: "Bengaluru", eventDate: "December 2026" } },
    stage: "contacted", assignedTo: owner._id, qualified: true,
    qualificationData: { groomName: "Aarav", brideName: "Meera", weddingStyle: "South Indian", venueStatus: "looking", servicesRequired: ["Decor", "Catering"], budgetAmount: 1800000, email: "aarav@example.com" },
  });
  // MB7b Slice 3: the summary now generates only for QUALIFIED leads, so the
  // empty-data path lives behind the qualified gate — this fixture is qualified
  // but carries no captured facts (exercises the "not enough info" branch).
  const emptyLead = await Enquiry.create({
    name: "Walk-in Enquiry", phone: "919900000511", verified: false, source: "Website", additionalInfo: {}, stage: "new", assignedTo: owner._id, qualified: true,
  });

  await new Promise((r) => mockServer.listen(MOCK_PORT, r));
  const child = spawn("node", ["server.js"], {
    cwd: `${__dirname}/..`,
    env: { ...process.env, PORT: String(APP_PORT), ANTHROPIC_API_URL: `http://localhost:${MOCK_PORT}/v1/messages`, GOOGLE_SHEETS_KEY_PATH: "/nonexistent/ks.json" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));

  const api = async (method, path, token) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });
    let data = null; try { data = await res.json(); } catch (_) {}
    return { status: res.status, data };
  };

  try {
    await waitFor(() => fetch(`${BASE}/`).then((r) => r.ok).catch(() => false), "server boot");

    console.log("\n── Generate + cache ──");
    const callsBefore = mock.calls.length;
    const gen = await api("GET", `/enquiry/${richLead._id}/kiara-summary`, ownerToken);
    ok(gen.status === 200 && gen.data.text === CANNED, "GET generates the summary from a mocked Anthropic call");
    ok(gen.data.cached === false && !!gen.data.generatedAt, "first GET is uncached, stamped");
    ok(mock.calls.length === callsBefore + 1, "exactly one Anthropic call");
    const sentPrompt = JSON.stringify(mock.calls[mock.calls.length - 1]);
    ok(sentPrompt.includes("Aarav") && sentPrompt.includes("Decor") && sentPrompt.includes("data extractor") === false, "prompt carries captured facts, founder-voice system prompt");
    const fresh = await Enquiry.findById(richLead._id).lean();
    ok(fresh.kiaraSummary && fresh.kiaraSummary.text === CANNED, "summary cached on the lead");

    console.log("\n── Cache hit (no second call) ──");
    const cached = await api("GET", `/enquiry/${richLead._id}/kiara-summary`, ownerToken);
    ok(cached.status === 200 && cached.data.cached === true, "second GET returns cached (cached:true)");
    ok(mock.calls.length === callsBefore + 1, "no extra Anthropic call on cache hit");

    console.log("\n── Regenerate (force) ──");
    const regen = await api("POST", `/enquiry/${richLead._id}/kiara-summary`, ownerToken);
    ok(regen.status === 200 && regen.data.cached === false, "POST regenerates (cached:false)");
    ok(mock.calls.length === callsBefore + 2, "regenerate makes a fresh Anthropic call");

    console.log("\n── Empty-data case ──");
    const callsBeforeEmpty = mock.calls.length;
    const empty = await api("GET", `/enquiry/${emptyLead._id}/kiara-summary`, ownerToken);
    ok(empty.status === 200 && empty.data.empty === true, "empty lead → graceful empty summary");
    ok(/not enough info/i.test(empty.data.text), "empty summary says 'not enough info yet'");
    ok(mock.calls.length === callsBeforeEmpty, "empty case makes NO Anthropic call");
    const emptyDoc = await Enquiry.findById(emptyLead._id).lean();
    ok(!emptyDoc.kiaraSummary || !emptyDoc.kiaraSummary.text, "empty summary is not cached (refreshes when data lands)");

    console.log("\n── RBAC lead-scope ──");
    const denied = await api("GET", `/enquiry/${richLead._id}/kiara-summary`, otherToken);
    ok(denied.status === 403, "own-scope admin who doesn't own the lead → 403");
    const deniedPost = await api("POST", `/enquiry/${richLead._id}/kiara-summary`, otherToken);
    ok(deniedPost.status === 403, "regenerate also scope-guarded (403)");
    const noAuth = await fetch(`${BASE}/enquiry/${richLead._id}/kiara-summary`);
    ok([400, 401, 403].includes(noAuth.status), `unauthenticated rejected (got ${noAuth.status})`);
  } catch (e) {
    fail++; failures.push(`fatal: ${e.message}`);
    console.error("FATAL", e); console.error("server log tail:", log.slice(-1500));
  } finally {
    await Enquiry.deleteMany({ _id: { $in: [richLead._id, emptyLead._id] } });
    await Admin.deleteMany({ _id: { $in: [owner._id, other._id] } });
    await Role.deleteMany({ _id: ownerRole._id });
    await Department.deleteMany({ _id: dept._id });
    child.kill(); mockServer.close(); await mongoose.disconnect();
    console.log(`\n══ RESULT: ${pass} passed, ${fail} failed ══`);
    if (failures.length) console.log("failures:", failures.join(" | "));
    process.exit(fail === 0 ? 0 : 1);
  }
})();
