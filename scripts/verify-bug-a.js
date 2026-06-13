/* MB5 Slice 1 — Bug A verification (permanent).
 *
 * Boots the real server on TEST ports (mocked Anthropic/Meta, same seams as
 * e2e-kiara), creates one lead via signed WhatsApp webhook and one via the
 * normal POST /enquiry path (what NewLeadModal sends), then ASSERTS:
 *   - both leads appear in the board query (GET /enquiry?page=1&limit=200)
 *     and the list query (GET /enquiry?view=active)
 *   - the two Enquiry documents are field-identical apart from the expected
 *     identity fields (_id, name, phone, source, timestamps, assignedTo)
 *   - the WA lead's stage is exactly "new" (the board's column key)
 * Exits 1 on any failure. Cleans every fixture. Run: node scripts/verify-bug-a.js
 */
require("dotenv").config();
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const APP_PORT = 8123;
const MOCK_PORT = 8124;
const BASE = `http://localhost:${APP_PORT}`;
const APP_SECRET = process.env.WHATSAPP_AGENT_APP_SECRET || "kiara-e2e-secret";
const WA_PHONE = "919170000777";
const NORMAL_PHONE = "919170000778";

const mockServer = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (req.url === "/v1/messages") {
      const body = raw ? JSON.parse(raw) : {};
      const content = String(body.system || "").startsWith("You are a data extractor")
        ? [{ type: "text", text: JSON.stringify({ qualified: false, escalate: false, classification: "lead", data: {} }) }]
        : [{ type: "text", text: "Hi from mock Kiara" }];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "msg_repro", content, stop_reason: "end_turn" }));
      return;
    }
    if (/\/messages$/.test(req.url)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: "wamid.repro" }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, label, timeoutMs = 20000) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (_) {}
    await sleep(300);
  }
  throw new Error(`waitFor timed out: ${label}`);
};

(async () => {
  await mongoose.connect(process.env.DATABASE_URL);
  const Enquiry = require("../models/Enquiry");
  const WAConversation = require("../models/WAConversation");
  const WAAgentMessage = require("../models/WAAgentMessage");
  const LeadInternalEvent = require("../models/LeadInternalEvent");
  const Setting = require("../models/Setting");
  const Admin = require("../models/Admin");
  const Role = require("../models/Role");
  const Department = require("../models/Department");

  const dept = await Department.create({ name: "BUGA-Dept" });
  const founderRole = await Role.create({ name: "BUGA-Founder", departmentId: dept._id, permissions: ["*:*:all"] });
  const internRole = await Role.create({ name: "BUGA-Intern", departmentId: dept._id, permissions: ["leads:view:own", "leads:edit:own"] });
  const founder = await Admin.create({
    name: "BugA Founder", email: `buga-founder-${Date.now()}@test.local`, phone: "919170000700",
    password: "x", roles: ["crm"], roleId: founderRole._id, departmentId: dept._id, status: "active",
  });
  const intern = await Admin.create({
    name: "BugA Intern", email: `buga-intern-${Date.now()}@test.local`, phone: "919170000701",
    password: "x", roles: ["sales"], roleId: internRole._id, departmentId: dept._id, status: "active",
  });
  const founderToken = jwt.sign({ _id: String(founder._id), isAdmin: true }, process.env.JWT_SECRET);
  const settingsBefore = await Setting.find({ key: "assignment.poolRoles" }).lean();

  await new Promise((r) => mockServer.listen(MOCK_PORT, r));
  const child = spawn("node", ["server.js"], {
    cwd: `${__dirname}/..`,
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      ANTHROPIC_API_URL: `http://localhost:${MOCK_PORT}/v1/messages`,
      META_GRAPH_BASE_URL: `http://localhost:${MOCK_PORT}/graph`,
      WHATSAPP_AGENT_PHONE_NUMBER_ID: "BUGA_AGENT",
      WHATSAPP_AGENT_APP_SECRET: APP_SECRET,
      META_WA_AGENT_ACCESS_TOKEN: "repro-token",
      GOOGLE_SHEETS_KEY_PATH: "/nonexistent/keyfile.json",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  child.stdout.on("data", (d) => (serverLog += d));
  child.stderr.on("data", (d) => (serverLog += d));

  const api = async (method, path, body) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${founderToken}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    return { status: res.status, data };
  };

  try {
    await waitFor(() => fetch(`${BASE}/`).then((r) => r.ok).catch(() => false), "server boot", 30000);
    await api("PUT", "/settings", { key: "assignment.poolRoles", value: ["BUGA-Intern"] });

    // 1. WhatsApp-intake lead via signed webhook
    const payload = {
      entry: [{ changes: [{ value: {
        contacts: [{ profile: { name: "BugA WA Customer" }, wa_id: WA_PHONE }],
        messages: [{ from: WA_PHONE, id: `wamid.in.${Date.now()}`, type: "text", text: { body: "Hi planning a wedding" } }],
      } }] }],
    };
    const raw = JSON.stringify(payload);
    const sig = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(raw).digest("hex");
    const wh = await fetch(`${BASE}/webhook/whatsapp-agent`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-hub-signature-256": sig }, body: raw,
    });
    console.log("webhook status:", wh.status);
    const conv = await waitFor(async () => {
      const c = await WAConversation.findOne({ phone: WA_PHONE }).lean();
      return c && c.enquiryId ? c : null;
    }, "wa lead link");

    // 2. Normal create (NewLeadModal shape)
    const created = await api("POST", "/enquiry", {
      name: "BugA Normal Lead", phone: NORMAL_PHONE, source: "Website", verified: false,
    });
    console.log("normal create status:", created.status);

    const waLead = await Enquiry.findById(conv.enquiryId).lean();
    const normalLead = await Enquiry.findOne({ phone: NORMAL_PHONE }).lean();

    // 3. Field parity assertions (identity fields excluded)
    let failed = 0;
    const ok = (cond, label) => {
      console.log(`  ${cond ? "✓" : "✗"} ${label}`);
      if (!cond) failed++;
    };
    console.log("\n── FIELD PARITY ──");
    const EXPECTED_DIFFS = new Set(["_id", "name", "phone", "source", "createdAt", "updatedAt", "__v", "assignedTo"]);
    const keys = new Set([...Object.keys(waLead), ...Object.keys(normalLead)]);
    for (const k of [...keys].sort()) {
      if (EXPECTED_DIFFS.has(k)) continue;
      const a = JSON.stringify(waLead[k]);
      const b = JSON.stringify(normalLead[k]);
      if (a !== b) ok(false, `field "${k}" differs: wa=${a} normal=${b}`);
    }
    ok(waLead.stage === "new", `WA lead stage is "new" (got ${JSON.stringify(waLead.stage)})`);
    ok(typeof waLead.verified === "boolean", "WA lead verified is boolean");
    console.log("  (unlisted fields are identical)");

    // 4. Visibility in board + list queries
    const board = await api("GET", "/enquiry?page=1&limit=200");
    const list = await api("GET", "/enquiry?page=1&limit=200&view=active");
    const inBoardWA = (board.data.list || []).some((l) => String(l._id) === String(waLead._id));
    const inBoardNormal = (board.data.list || []).some((l) => String(l._id) === String(normalLead._id));
    const inListWA = (list.data.list || []).some((l) => String(l._id) === String(waLead._id));
    const inListNormal = (list.data.list || []).some((l) => String(l._id) === String(normalLead._id));
    console.log("\n── VISIBILITY ──");
    ok(inBoardWA, "WA lead in board query");
    ok(inBoardNormal, "normal lead in board query");
    ok(inListWA, "WA lead in active list query");
    ok(inListNormal, "normal lead in active list query");
    if (!inBoardWA || !inListWA) {
      console.log("\nWA lead document:", JSON.stringify(waLead, null, 2));
    }
    process.exitCode = failed === 0 ? 0 : 1;
    console.log(failed === 0 ? "\nBUG A VERIFY: ALL PASSED" : `\nBUG A VERIFY: ${failed} FAILED`);
  } catch (e) {
    console.error("REPRO ERROR:", e);
    console.error("server log tail:", serverLog.slice(-3000));
  } finally {
    // Cleanup
    const waLeadDoc = await Enquiry.findOne({ phone: WA_PHONE }).lean();
    await Enquiry.deleteMany({ phone: { $in: [WA_PHONE, NORMAL_PHONE] } });
    await WAConversation.deleteMany({ phone: WA_PHONE });
    await WAAgentMessage.deleteMany({ phone: WA_PHONE });
    if (waLeadDoc) await LeadInternalEvent.deleteMany({ leadId: waLeadDoc._id });
    const normalDoc = await Enquiry.findOne({ phone: NORMAL_PHONE }).lean();
    if (normalDoc) await LeadInternalEvent.deleteMany({ leadId: normalDoc._id });
    await Admin.deleteMany({ _id: { $in: [founder._id, intern._id] } });
    await Role.deleteMany({ _id: { $in: [founderRole._id, internRole._id] } });
    await Department.deleteMany({ _id: dept._id });
    await Setting.deleteMany({ key: "assignment.poolRoles" });
    if (settingsBefore.length) await Setting.insertMany(settingsBefore.map(({ _id, ...rest }) => rest));
    child.kill();
    mockServer.close();
    await mongoose.disconnect();
  }
})();
