/* MEGA-BUILD 5+6 — end-to-end suite (grows slice by slice).
 *
 * Boots the real server on TEST ports with Anthropic/Meta mocked (same seams
 * as e2e-kiara) and drives the new surfaces: attendance, calendar/meeting
 * mode/huddles, triage, safety net, cockpit v2, Google (mocked), filters,
 * metrics, 429 queue. Local DB only; cleans every fixture it creates.
 *
 * Run: node scripts/e2e-mb56.js
 */
require("dotenv").config();
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const APP_PORT = 8127;
const MOCK_PORT = 8128;
const BASE = `http://localhost:${APP_PORT}`;
const APP_SECRET = process.env.WHATSAPP_AGENT_APP_SECRET || "kiara-e2e-secret";
const PHONE_PREFIX = "9191000"; // every mb56 test phone starts with this
const MARK = "MB56-E2E";

// ── Tiny harness ──────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];
const ok = (cond, label) => {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.error(`  ✗ ${label}`);
  }
};
const section = (t) => console.log(`\n── ${t} ──`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, label, timeoutMs = 20000, everyMs = 300) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (_) {}
    await sleep(everyMs);
  }
  throw new Error(`waitFor timed out: ${label}`);
};

// ── Mock Anthropic + Meta ─────────────────────────────────────────────────────
const mock = {
  anthropicCalls: [],
  metaCalls: [],
  replyText: "Lovely! Tell me more 😊",
  extractor: { qualified: false, escalate: false, escalateReason: "", classification: "lead", data: {} },
  anthropic429s: 0, // consume N 429s before answering (Slice 11)
};
const mockServer = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    if (req.url === "/v1/messages") {
      if (mock.anthropic429s > 0) {
        mock.anthropic429s--;
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error" } }));
        return;
      }
      mock.anthropicCalls.push({ system: body.system, messages: body.messages });
      const content = String(body.system || "").startsWith("You are a data extractor")
        ? [{ type: "text", text: JSON.stringify(mock.extractor) }]
        : [{ type: "text", text: mock.replyText }];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "msg_mb56", content, stop_reason: "end_turn" }));
      return;
    }
    const graph = req.url.match(/^\/graph\/([^/]+)\/messages$/);
    if (graph) {
      mock.metaCalls.push({ phoneNumberId: graph[1], body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: "wamid.mb56" }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
});

// ── HTTP helpers ──────────────────────────────────────────────────────────────
const api = async (method, path, { token, body } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {}
  return { status: res.status, data };
};
const signedWebhook = async (payload) => {
  const raw = JSON.stringify(payload);
  const sig = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(raw).digest("hex");
  const res = await fetch(`${BASE}/webhook/whatsapp-agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-hub-signature-256": sig },
    body: raw,
  });
  return res.status;
};
const inboundText = (phone, text, profileName = "MB56 Customer") => ({
  entry: [
    {
      changes: [
        {
          value: {
            contacts: [{ profile: { name: profileName }, wa_id: phone }],
            messages: [{ from: phone, id: `wamid.in.${Date.now()}.${Math.floor(Math.random() * 1e6)}`, type: "text", text: { body: text } }],
          },
        },
      ],
    },
  ],
});

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  if (!process.env.DATABASE_URL || !process.env.JWT_SECRET) {
    console.error("DATABASE_URL / JWT_SECRET missing.");
    process.exit(1);
  }
  await mongoose.connect(process.env.DATABASE_URL);
  const Enquiry = require("../models/Enquiry");
  const WAConversation = require("../models/WAConversation");
  const WAAgentMessage = require("../models/WAAgentMessage");
  const QualifiedLead = require("../models/QualifiedLead");
  const LeadInternalEvent = require("../models/LeadInternalEvent");
  const NotificationFailureLog = require("../models/NotificationFailureLog");
  const Setting = require("../models/Setting");
  const Admin = require("../models/Admin");
  const Role = require("../models/Role");
  const Department = require("../models/Department");
  const Attendance = require("../models/Attendance");

  // ── Fixtures ────────────────────────────────────────────────────────────────
  const dept = await Department.create({ name: `${MARK} Dept` });
  const founderRole = await Role.create({
    name: `${MARK} Founder`,
    departmentId: dept._id,
    permissions: ["*:*:all"],
  });
  const salesLeadRole = await Role.create({
    name: `${MARK} SalesLead`,
    departmentId: dept._id,
    permissions: ["leads:view:team", "leads:edit:team"],
  });
  const internRole = await Role.create({
    name: `${MARK} Intern`,
    departmentId: dept._id,
    permissions: ["leads:view:own", "leads:edit:own"],
  });
  const founder = await Admin.create({
    name: `${MARK} Founder`,
    email: `mb56-founder-${Date.now()}@test.local`,
    phone: "919191000001",
    password: "x",
    roles: ["crm", "owner"],
    roleId: founderRole._id,
    departmentId: dept._id,
    status: "active",
  });
  const salesLead = await Admin.create({
    name: `${MARK} SalesLead`,
    email: `mb56-saleslead-${Date.now()}@test.local`,
    phone: "919191000002",
    password: "x",
    roles: ["sales"],
    roleId: salesLeadRole._id,
    departmentId: dept._id,
    status: "active",
  });
  const intern = await Admin.create({
    name: `${MARK} Intern`,
    email: `mb56-intern-${Date.now()}@test.local`,
    phone: "919191000003",
    password: "x",
    roles: ["sales"],
    roleId: internRole._id,
    departmentId: dept._id,
    reportingManagerId: salesLead._id,
    status: "active",
  });
  const tok = (a) => jwt.sign({ _id: String(a._id), isAdmin: true }, process.env.JWT_SECRET);
  const founderToken = tok(founder);
  const salesLeadToken = tok(salesLead);
  const internToken = tok(intern);

  const touchedKeys = ["assignment.poolRoles"];
  const settingsBefore = await Setting.find({ key: { $in: touchedKeys } }).lean();

  await new Promise((r) => mockServer.listen(MOCK_PORT, r));
  const child = spawn("node", ["server.js"], {
    cwd: `${__dirname}/..`,
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      ANTHROPIC_API_URL: `http://localhost:${MOCK_PORT}/v1/messages`,
      META_GRAPH_BASE_URL: `http://localhost:${MOCK_PORT}/graph`,
      WHATSAPP_AGENT_PHONE_NUMBER_ID: "MB56_AGENT",
      WHATSAPP_AGENT_APP_SECRET: APP_SECRET,
      META_WA_AGENT_ACCESS_TOKEN: "mb56-token",
      GOOGLE_SHEETS_KEY_PATH: "/nonexistent/mb56-keyfile.json",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  child.stdout.on("data", (d) => (serverLog += d));
  child.stderr.on("data", (d) => (serverLog += d));

  const phones = [];
  const phone = (n) => {
    const p = `${PHONE_PREFIX}${String(n).padStart(5, "0")}`;
    if (!phones.includes(p)) phones.push(p);
    return p;
  };

  try {
    await waitFor(() => fetch(`${BASE}/`).then((r) => r.ok).catch(() => false), "server boot", 30000);
    await api("PUT", "/settings", {
      token: founderToken,
      body: { key: "assignment.poolRoles", value: [`${MARK} Intern`] },
    });

    // ════ SLICE 2 — Attendance & employee status ════
    section("S2: check-in / heartbeat / idle / check-out");
    let me = await api("GET", "/attendance/me", { token: internToken });
    ok(me.status === 200 && me.data.status === "checked_out", "fresh day starts checked_out");

    let ci = await api("POST", "/attendance/check-in", { token: internToken });
    ok(ci.status === 200 && ci.data.status === "online" && ci.data.checkInAt, "check-in → online");

    const ciAgain = await api("POST", "/attendance/check-in", { token: internToken });
    ok(ciAgain.status === 200, "check-in is idempotent");

    let hb = await api("POST", "/attendance/heartbeat", { token: internToken });
    ok(hb.status === 200, "heartbeat accepted while checked in");

    // Simulate 6 minutes of silence by rewinding lastHeartbeatAt in the DB.
    await Attendance.updateOne(
      { adminId: intern._id },
      { $set: { lastHeartbeatAt: new Date(Date.now() - 6 * 60 * 1000) } }
    );
    me = await api("GET", "/attendance/me", { token: internToken });
    ok(me.data.status === "idle", "5-min heartbeat gap derives idle");

    hb = await api("POST", "/attendance/heartbeat", { token: internToken });
    me = await api("GET", "/attendance/me", { token: internToken });
    ok(me.data.status === "online", "heartbeat after gap → back online");
    ok(me.data.idleMs >= 6 * 60 * 1000 - 5000, `gap recorded as idle (idleMs=${me.data.idleMs})`);
    const att = await Attendance.findOne({ adminId: intern._id }).lean();
    ok(att.idleSegments.length === 1, "idle segment persisted");

    section("S2: transparency + team scope");
    ok(typeof me.data.idleMs === "number" && me.data.checkInAt, "employee sees own status + idle total");

    const teamFounder = await api("GET", "/attendance/team", { token: founderToken });
    ok(teamFounder.status === 200, "founder team list loads");
    const fNames = (teamFounder.data.list || []).map((r) => r.name);
    ok(fNames.includes(`${MARK} Intern`) && fNames.includes(`${MARK} Founder`), "founder sees everyone");

    const teamIntern = await api("GET", "/attendance/team", { token: internToken });
    const iRows = (teamIntern.data.list || []).filter((r) => String(r.name).startsWith(MARK));
    ok(iRows.length === 1 && iRows[0].name === `${MARK} Intern`, "own-scope intern sees only self");

    const teamLead = await api("GET", "/attendance/team", { token: salesLeadToken });
    const lNames = (teamLead.data.list || []).map((r) => r.name);
    ok(
      lNames.includes(`${MARK} Intern`) && lNames.includes(`${MARK} SalesLead`) && !lNames.includes(`${MARK} Founder`),
      "team-scope sales lead sees self + subordinate, not founder"
    );
    const internRow = (teamLead.data.list || []).find((r) => r.name === `${MARK} Intern`);
    ok(internRow && internRow.status === "online" && internRow.idleMs >= 0, "team row carries live status + idle");

    section("S2: check-out");
    let co = await api("POST", "/attendance/check-out", { token: internToken });
    ok(co.status === 200 && co.data.status === "checked_out" && co.data.checkOutAt, "check-out → checked_out");
    co = await api("POST", "/attendance/check-out", { token: internToken });
    ok(co.status === 409, "double check-out rejected (409)");
    ci = await api("POST", "/attendance/check-in", { token: internToken });
    ok(ci.status === 200 && ci.data.status === "online" && !ci.data.checkOutAt, "re-check-in re-opens the day");
    const att2 = await Attendance.findOne({ adminId: intern._id }).lean();
    ok(att2.idleSegments.length >= 1 && att2.checkInAt, "timestamps persist across the day (payroll-safe)");
    await api("POST", "/attendance/check-out", { token: internToken });
  } catch (e) {
    failed++;
    failures.push(`fatal: ${e.message}`);
    console.error("FATAL:", e);
    console.error("server log tail:", serverLog.slice(-2000));
  } finally {
    section("Cleanup");
    const leads = await Enquiry.find({ phone: { $regex: `^${PHONE_PREFIX}` } }, { _id: 1 }).lean();
    const leadIds = leads.map((l) => l._id);
    await LeadInternalEvent.deleteMany({ leadId: { $in: leadIds } });
    await Enquiry.deleteMany({ phone: { $regex: `^${PHONE_PREFIX}` } });
    await WAConversation.deleteMany({ phone: { $regex: `^${PHONE_PREFIX}` } });
    await WAAgentMessage.deleteMany({ phone: { $regex: `^${PHONE_PREFIX}` } });
    await QualifiedLead.deleteMany({ phone: { $regex: `^${PHONE_PREFIX}` } });
    await NotificationFailureLog.deleteMany({ phone: { $regex: `^${PHONE_PREFIX}` } });
    await Attendance.deleteMany({ adminId: { $in: [founder._id, salesLead._id, intern._id] } });
    await Admin.deleteMany({ _id: { $in: [founder._id, salesLead._id, intern._id] } });
    await Role.deleteMany({ _id: { $in: [founderRole._id, salesLeadRole._id, internRole._id] } });
    await Department.deleteMany({ _id: dept._id });
    await Setting.deleteMany({ key: { $in: touchedKeys } });
    if (settingsBefore.length) await Setting.insertMany(settingsBefore.map(({ _id, ...rest }) => rest));
    const leftovers = await Promise.all([
      Enquiry.countDocuments({ phone: { $regex: `^${PHONE_PREFIX}` } }),
      WAConversation.countDocuments({ phone: { $regex: `^${PHONE_PREFIX}` } }),
      Admin.countDocuments({ email: { $regex: "^mb56-" } }),
      Attendance.countDocuments({ adminId: { $in: [founder._id, salesLead._id, intern._id] } }),
    ]);
    console.log(`  cleanup leftovers (should be all 0): ${leftovers.join(", ")}`);
    child.kill();
    mockServer.close();
    await mongoose.disconnect();
    console.log(`\n══ RESULT: ${passed} passed, ${failed} failed ══`);
    if (failures.length) console.log("failures:", failures.join(" | "));
    process.exit(failed === 0 ? 0 : 1);
  }
})();
