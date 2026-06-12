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
  igCalls: [], // Instagram DM sends (Slice 7)
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
    if (req.url === "/iggraph/me/messages") {
      mock.igCalls.push({ body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ recipient_id: body.recipient && body.recipient.id, message_id: "igm.mb56" }));
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
const signedIgWebhook = async (instagramId, text) => {
  const payload = {
    entry: [{ messaging: [{ sender: { id: instagramId }, message: { text } }] }],
  };
  const raw = JSON.stringify(payload);
  const sig = "sha256=" + crypto.createHmac("sha256", "mb56-ig-secret").update(raw).digest("hex");
  const res = await fetch(`${BASE}/webhook/instagram-agent`, {
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

  const touchedKeys = [
    "assignment.poolRoles",
    "assignment.mode",
    "triage.escalateAfterMinutes",
    "golden.workStartHour",
    "golden.workEndHour",
    "golden.windowMinutes",
    "kiara.welcomeTemplateName",
  ];
  const settingsBefore = await Setting.find({ key: { $in: touchedKeys } }).lean();

  // Triage-holder fixture (sales-lead-class role with the new permission).
  const holderRole = await Role.create({
    name: `${MARK} TriageHolder`,
    departmentId: dept._id,
    permissions: ["leads:view:all", "leads:edit:all", "leads:triage:all"],
  });
  const holder = await Admin.create({
    name: `${MARK} Holder`,
    email: `mb56-holder-${Date.now()}@test.local`,
    phone: "919191000004",
    password: "x",
    roles: ["sales"],
    roleId: holderRole._id,
    departmentId: dept._id,
    status: "active",
  });
  // Revenue Head: reuse the real role if the dev DB has it, else create one.
  let rhRole = await Role.findOne({ name: "Revenue Head", deletedAt: null });
  const rhRoleCreated = !rhRole;
  if (!rhRole) {
    rhRole = await Role.create({ name: "Revenue Head", departmentId: dept._id, permissions: ["leads:view:all"] });
  }
  const revenueHead = await Admin.create({
    name: `${MARK} RevenueHead`,
    email: `mb56-rh-${Date.now()}@test.local`,
    phone: "919191000005",
    password: "x",
    roles: ["sales"],
    roleId: rhRole._id,
    departmentId: dept._id,
    status: "active",
  });

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
      INSTAGRAM_AGENT_APP_SECRET: "mb56-ig-secret",
      INSTAGRAM_AGENT_PAGE_ACCESS_TOKEN: "mb56-ig-token",
      INSTAGRAM_GRAPH_BASE_URL: `http://localhost:${MOCK_PORT}/iggraph`,
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

    // ════ SLICE 3 — Calendar, meeting mode, huddle, handoff ════
    section("S3: handoff — meet booked on intern-owned lead");
    const lead1 = await Enquiry.create({
      name: `${MARK} HandoffLead`,
      phone: phone(101),
      verified: false,
      source: "Website",
      additionalInfo: {},
      stage: "new",
      assignedTo: intern._id,
    });
    const meetAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000); // +2 days
    const bookMeet = await api("POST", `/enquiry/${lead1._id}/follow-up`, {
      token: internToken,
      body: { type: "meet", scheduledAt: meetAt.toISOString(), promiseNote: "demo" },
    });
    ok(bookMeet.status === 200 || bookMeet.status === 201, "meet follow-up booked");
    const lead1After = await Enquiry.findById(lead1._id).lean();
    ok(String(lead1After.assignedTo) === String(salesLead._id), "lead auto-transferred to reportingManager");
    ok(String(lead1After.qualifiedBy) === String(intern._id), "intern permanently credited (qualifiedBy)");
    ok(
      !!(await LeadInternalEvent.findOne({ leadId: lead1._id, type: "meet_handoff" }).lean()),
      "journey event meet_handoff"
    );
    ok(
      !!(await LeadInternalEvent.findOne({ leadId: lead1._id, type: "transferred", "payload.reason": "meet_handoff" }).lean()),
      "journey event transferred (reason meet_handoff)"
    );
    const AdminNotification = require("../models/AdminNotification");
    ok(
      !!(await AdminNotification.findOne({ adminId: intern._id, type: "meet_handoff" }).lean()) &&
        !!(await AdminNotification.findOne({ adminId: salesLead._id, type: "meet_handoff" }).lean()),
      "both intern and manager notified"
    );
    const CalendarEvent = require("../models/CalendarEvent");
    const gmeetEv = await CalendarEvent.findOne({ leadId: lead1._id, type: "gmeet" }).lean();
    ok(!!gmeetEv && String(gmeetEv.ownerId) === String(salesLead._id), "gmeet mirrored onto the manager's calendar");
    const huddleEv = await CalendarEvent.findOne({ leadId: lead1._id, type: "huddle", status: "scheduled" }).lean();
    ok(!!huddleEv && String(huddleEv.ownerId) === String(salesLead._id), "huddle auto-created for the sales lead");

    section("S3: huddle countdown chip + completion");
    let leadCal = await api("GET", `/calendar/lead/${lead1._id}`, { token: salesLeadToken });
    ok(
      leadCal.status === 200 && leadCal.data.huddle && leadCal.data.huddle.pending && leadCal.data.huddle.msToMeet > 0,
      "client-file chip: huddle pending with countdown"
    );
    const noNotes = await api("POST", `/calendar/huddles/${huddleEv._id}/complete`, {
      token: salesLeadToken,
      body: { attendeeIds: [String(salesLead._id)], eventTeam: [] },
    });
    ok(noNotes.status === 422, "huddle completion requires notes (422)");
    const huddleDone = await api("POST", `/calendar/huddles/${huddleEv._id}/complete`, {
      token: salesLeadToken,
      body: {
        attendeeIds: [String(salesLead._id), String(intern._id)],
        eventTeam: [{ adminId: String(intern._id), label: "Decor" }],
        notes: "Aligned on decor budget and venue pitch",
      },
    });
    ok(huddleDone.status === 200 && huddleDone.data.status === "closed", "huddle completed");
    const lead1Team = await Enquiry.findById(lead1._id).lean();
    ok(
      (lead1Team.eventTeam || []).length === 1 && lead1Team.eventTeam[0].label === "Decor",
      "eventTeam written onto the lead"
    );
    ok(
      !!(await LeadInternalEvent.findOne({ leadId: lead1._id, type: "huddle_completed" }).lean()),
      "journey event huddle_completed"
    );
    leadCal = await api("GET", `/calendar/lead/${lead1._id}`, { token: salesLeadToken });
    ok(leadCal.data.huddle && leadCal.data.huddle.pending === false, "chip flips to huddle-complete");

    section("S3: meeting-notes gate + blocking");
    // A meeting that is already over (unclosed).
    const pastMeeting = await api("POST", "/calendar/events", {
      token: internToken,
      body: {
        type: "meeting",
        title: "MB56 past client meeting",
        start: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        end: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        leadId: String(lead1._id),
      },
    });
    ok(pastMeeting.status === 201, "past meeting created (test fixture)");
    const closeNoNotes = await api("POST", `/calendar/events/${pastMeeting.data._id}/close`, {
      token: internToken,
      body: {},
    });
    ok(closeNoNotes.status === 422, "meeting cannot be closed without notes (422)");
    const blockedNext = await api("POST", "/calendar/events", {
      token: internToken,
      body: {
        type: "meeting",
        title: "MB56 next meeting",
        start: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        end: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      },
    });
    ok(blockedNext.status === 422, "unclosed meeting BLOCKS starting the next one (422)");
    let mm = await api("GET", "/calendar/meeting-mode", { token: internToken });
    ok(mm.status === 200 && mm.data.blocked && mm.data.unclosed.length === 1, "meeting-mode: unclosed pinned + blocked");
    const unclosedRH = await api("GET", "/calendar/unclosed", { token: salesLeadToken });
    ok(
      unclosedRH.status === 200 &&
        (unclosedRH.data.list || []).some((u) => String(u._id) === String(pastMeeting.data._id)),
      "Revenue-Head view lists the team's unclosed meetings"
    );
    const draftNotes = await api("PUT", `/calendar/events/${pastMeeting.data._id}/notes`, {
      token: internToken,
      body: { notes: "Client wants pastel decor, budget 12L" },
    });
    ok(draftNotes.status === 200, "live notes pane saves a draft");
    const closeOk = await api("POST", `/calendar/events/${pastMeeting.data._id}/close`, {
      token: internToken,
      body: {},
    });
    ok(closeOk.status === 200 && closeOk.data.status === "closed", "close succeeds using the captured notes");
    ok(
      !!(await LeadInternalEvent.findOne({ leadId: lead1._id, type: "meeting_closed" }).lean()),
      "journey event meeting_closed"
    );
    const unblocked = await api("POST", "/calendar/events", {
      token: internToken,
      body: {
        type: "meeting",
        title: "MB56 live meeting",
        start: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        end: new Date(Date.now() + 50 * 60 * 1000).toISOString(),
        leadId: String(lead1._id),
      },
    });
    ok(unblocked.status === 201, "after closing, the next meeting can start");

    section("S3: live meeting → banner + in_meeting status");
    mm = await api("GET", "/calendar/meeting-mode", { token: internToken });
    ok(
      mm.data.live && String(mm.data.live._id) === String(unblocked.data._id) && mm.data.live.lead,
      "meeting banner: live meeting with lead attached"
    );
    await api("POST", "/attendance/check-in", { token: internToken });
    me = await api("GET", "/attendance/me", { token: internToken });
    ok(me.data.status === "in_meeting", "status derives in_meeting while a meeting is live");
    const grid = await api(
      "GET",
      `/calendar/team?from=${new Date(Date.now() - 24 * 3600 * 1000).toISOString()}&to=${new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString()}`,
      { token: founderToken }
    );
    const internRowCal = (grid.data.rows || []).find((r) => r.name === `${MARK} Intern`);
    ok(
      grid.status === 200 && internRowCal && internRowCal.events.some((e) => e.live) && internRowCal.status === "in_meeting",
      "team calendar: per-employee row with live event + status dot"
    );
    const slRow = (grid.data.rows || []).find((r) => r.name === `${MARK} SalesLead`);
    ok(slRow && slRow.events.some((e) => e.type === "gmeet"), "team calendar: mirrored gmeet visible on manager row");
    // Close the live meeting so later slices aren't blocked.
    await api("POST", `/calendar/events/${unblocked.data._id}/close`, {
      token: internToken,
      body: { notes: "wrap" },
    });
    await api("POST", "/attendance/check-out", { token: internToken });

    section("S3: visit mirror (no huddle, no handoff)");
    const lead2 = await Enquiry.create({
      name: `${MARK} VisitLead`,
      phone: phone(102),
      verified: false,
      source: "Website",
      additionalInfo: {},
      stage: "new",
      assignedTo: salesLead._id,
    });
    await api("POST", `/enquiry/${lead2._id}/follow-up`, {
      token: salesLeadToken,
      body: { type: "visit", scheduledAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString() },
    });
    ok(
      !!(await CalendarEvent.findOne({ leadId: lead2._id, type: "visit" }).lean()),
      "visit follow-up mirrors as a visit event"
    );
    ok(
      !(await CalendarEvent.findOne({ leadId: lead2._id, type: "huddle" }).lean()),
      "no huddle for a visit"
    );
    const lead2After = await Enquiry.findById(lead2._id).lean();
    ok(String(lead2After.assignedTo) === String(salesLead._id), "no handoff for a non-intern owner");

    // ════ SLICE 4 — Triage & escalation ════
    section("S4: triage mode — new leads land unassigned");
    const holderToken = tok(holder);
    // Force "working hours" deterministically for the sweep assertions.
    await api("PUT", "/settings", { token: founderToken, body: { key: "golden.workStartHour", value: 0 } });
    await api("PUT", "/settings", { token: founderToken, body: { key: "golden.workEndHour", value: 24 } });
    const modePut = await api("PUT", "/settings", {
      token: founderToken,
      body: { key: "assignment.mode", value: "triage" },
    });
    ok(modePut.status === 200, "assignment.mode flips to triage in Settings");

    const pT1 = phone(201);
    await signedWebhook(inboundText(pT1, "Hi! Need wedding decor", "Triage One"));
    const convT1 = await waitFor(async () => {
      const c = await WAConversation.findOne({ phone: pT1 }).lean();
      return c && c.enquiryId ? c : null;
    }, "triage lead linked");
    const leadT1 = await Enquiry.findById(convT1.enquiryId).lean();
    ok(leadT1.assignedTo === null && leadT1.triagePending === true, "triage-mode lead lands UNASSIGNED in triage");
    ok(
      !!(await LeadInternalEvent.findOne({ leadId: leadT1._id, type: "triage_entered" }).lean()),
      "journey event triage_entered"
    );

    section("S4: triage view — gated, transcript, golden freshness");
    const deny = await api("GET", "/enquiry/triage", { token: internToken });
    ok(deny.status === 403, "intern without leads:triage gets 403");
    let queue = await api("GET", "/enquiry/triage", { token: holderToken });
    ok(queue.status === 200, "triage holder can read the queue");
    const qRow = (queue.data.list || []).find((r) => String(r._id) === String(leadT1._id));
    ok(!!qRow && qRow.source === "whatsapp", "queue row carries source");
    ok(qRow && qRow.transcript.length >= 1 && qRow.transcript[0].message.includes("decor"), "Kiara transcript preview attached");
    ok(qRow && qRow.goldenWindow && typeof qRow.goldenWindow.inWindow === "boolean", "freshness vs golden window attached");
    const viewTriage = await api("GET", "/enquiry?view=triage&limit=50", { token: holderToken });
    ok(
      (viewTriage.data.list || []).some((l) => String(l._id) === String(leadT1._id)),
      "leads filter view=triage shows the queue"
    );
    const pickerResp = await api("GET", "/enquiry/triage/interns", { token: holderToken });
    const pickerIntern = (pickerResp.data.list || []).find((i) => String(i._id) === String(intern._id));
    ok(!!pickerIntern && typeof pickerIntern.status === "string", "intern picker shows live status");

    section("S4: assign + take-it-myself");
    const assignResp = await api("POST", `/enquiry/${leadT1._id}/triage-assign`, {
      token: holderToken,
      body: { adminId: String(intern._id) },
    });
    ok(assignResp.status === 200 && String(assignResp.data.assignedTo) === String(intern._id), "assign to intern works");
    ok(
      !!(await LeadInternalEvent.findOne({ leadId: leadT1._id, type: "triage_assigned" }).lean()),
      "journey event triage_assigned"
    );
    ok(
      !!(await AdminNotification.findOne({ adminId: intern._id, type: "triage_assigned" }).lean()),
      "assignee notified"
    );
    const pT2 = phone(202);
    await signedWebhook(inboundText(pT2, "Venue enquiry", "Triage Two"));
    const convT2 = await waitFor(async () => {
      const c = await WAConversation.findOne({ phone: pT2 }).lean();
      return c && c.enquiryId ? c : null;
    }, "triage lead 2 linked");
    const takeResp = await api("POST", `/enquiry/${convT2.enquiryId}/triage-assign`, { token: holderToken });
    ok(String(takeResp.data.assignedTo) === String(holder._id), "take-it-myself assigns to the caller");
    const selfEv = await LeadInternalEvent.findOne({ leadId: convT2.enquiryId, type: "triage_assigned" }).lean();
    ok(selfEv && selfEv.payload.self === true, "self-assign flagged in the journey");

    section("S4: escalation — notify holders after N minutes");
    // Holder is checked in and online — an available human, so NO auto-assign.
    await api("POST", "/attendance/check-in", { token: holderToken });
    const pT3 = phone(203);
    await signedWebhook(inboundText(pT3, "Catering query", "Triage Three"));
    const convT3 = await waitFor(async () => {
      const c = await WAConversation.findOne({ phone: pT3 }).lean();
      return c && c.enquiryId ? c : null;
    }, "triage lead 3 linked");
    // Mock the clock: rewind triageEnteredAt past the 10-min default.
    await Enquiry.updateOne(
      { _id: convT3.enquiryId },
      { $set: { triageEnteredAt: new Date(Date.now() - 11 * 60 * 1000) } }
    );
    queue = await api("GET", "/enquiry/triage", { token: holderToken }); // sweep rides the read
    const t3 = await Enquiry.findById(convT3.enquiryId).lean();
    ok(!!t3.triageEscalatedAt, "lead escalated after escalateAfterMinutes");
    ok(t3.triagePending === true && t3.assignedTo === null, "holders available → NOT auto-assigned");
    ok(
      !!(await AdminNotification.findOne({ adminId: holder._id, type: "triage_escalation", leadId: t3._id }).lean()),
      "all triage holders notified"
    );
    const secondSweep = await api("GET", "/enquiry/triage", { token: holderToken });
    const escalations = await AdminNotification.countDocuments({ adminId: holder._id, type: "triage_escalation", leadId: t3._id });
    ok(secondSweep.status === 200 && escalations === 1, "escalation fires once per lead");

    section("S4: all holders in_meeting → auto-assign to online intern");
    // Holder goes into a live meeting; intern is checked in + online.
    const holderMeeting = await api("POST", "/calendar/events", {
      token: holderToken,
      body: {
        type: "meeting",
        title: "MB56 holder busy",
        start: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        end: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      },
    });
    ok(holderMeeting.status === 201, "holder meeting live (fixture)");
    await api("POST", "/attendance/check-in", { token: internToken });
    const pT4 = phone(204);
    await signedWebhook(inboundText(pT4, "Photography packages?", "Triage Four"));
    const convT4 = await waitFor(async () => {
      const c = await WAConversation.findOne({ phone: pT4 }).lean();
      return c && c.enquiryId ? c : null;
    }, "triage lead 4 linked");
    await Enquiry.updateOne(
      { _id: convT4.enquiryId },
      { $set: { triageEnteredAt: new Date(Date.now() - 11 * 60 * 1000) } }
    );
    await api("GET", "/enquiry/dashboard", { token: founderToken }); // sweep also rides the dashboard
    const t4 = await Enquiry.findById(convT4.enquiryId).lean();
    ok(String(t4.assignedTo) === String(intern._id) && t4.triagePending === false, "auto-assigned to the online intern");
    const autoEv = await LeadInternalEvent.findOne({ leadId: t4._id, type: "triage_auto_assigned" }).lean();
    ok(autoEv && autoEv.payload.reason === "auto-assigned: triage was in meetings", "journey carries the reason");
    ok(
      !!(await AdminNotification.findOne({ adminId: revenueHead._id, type: "triage_auto_assigned", leadId: t4._id }).lean()),
      "Revenue Head notified"
    );
    ok(
      !!(await AdminNotification.findOne({ adminId: salesLead._id, type: "triage_auto_assigned", leadId: t4._id }).lean()),
      "intern's sales lead notified with the reason"
    );
    ok(
      !!(await AdminNotification.findOne({ adminId: intern._id, type: "triage_auto_assigned", leadId: t4._id }).lean()),
      "intern notified"
    );

    section("S4: working-hours gate");
    // Move "working hours" away from now → sweep must not escalate.
    const istHourNow = new Date(Date.now() + 330 * 60 * 1000).getUTCHours();
    const offStart = istHourNow >= 22 ? 0 : istHourNow + 1;
    const offEnd = istHourNow >= 22 ? 1 : istHourNow + 2;
    await api("PUT", "/settings", { token: founderToken, body: { key: "golden.workStartHour", value: offStart } });
    await api("PUT", "/settings", { token: founderToken, body: { key: "golden.workEndHour", value: offEnd } });
    const pT5 = phone(205);
    await signedWebhook(inboundText(pT5, "Mehendi artists?", "Triage Five"));
    const convT5 = await waitFor(async () => {
      const c = await WAConversation.findOne({ phone: pT5 }).lean();
      return c && c.enquiryId ? c : null;
    }, "triage lead 5 linked");
    await Enquiry.updateOne(
      { _id: convT5.enquiryId },
      { $set: { triageEnteredAt: new Date(Date.now() - 11 * 60 * 1000) } }
    );
    await api("GET", "/enquiry/triage", { token: holderToken });
    const t5 = await Enquiry.findById(convT5.enquiryId).lean();
    ok(!t5.triageEscalatedAt, "outside working hours → no escalation (morning pile)");
    // Restore working hours + close the holder's meeting + flip back to auto.
    await api("PUT", "/settings", { token: founderToken, body: { key: "golden.workStartHour", value: 0 } });
    await api("PUT", "/settings", { token: founderToken, body: { key: "golden.workEndHour", value: 24 } });
    await api("POST", `/calendar/events/${holderMeeting.data._id}/close`, { token: holderToken, body: { notes: "done" } });
    await api("POST", "/attendance/check-out", { token: internToken });
    await api("POST", "/attendance/check-out", { token: holderToken });
    const backToAuto = await api("PUT", "/settings", {
      token: founderToken,
      body: { key: "assignment.mode", value: "auto" },
    });
    ok(backToAuto.status === 200, "assignment.mode back to auto (zero-change default)");

    // ════ SLICE 5 — Golden window 15 + Kiara safety net ════
    section("S5: new defaults (code-level, no stored override)");
    {
      // In THIS process (fresh SettingsService cache), with no stored rows the
      // defaults must be 15 / 11 / 19.
      const stored = await Setting.find({
        key: { $in: ["golden.windowMinutes", "golden.workStartHour", "golden.workEndHour"] },
      }).lean();
      await Setting.deleteMany({
        key: { $in: ["golden.windowMinutes", "golden.workStartHour", "golden.workEndHour"] },
      });
      const SettingsServiceLocal = require("../services/SettingsService");
      SettingsServiceLocal.invalidate ? SettingsServiceLocal.invalidate() : null;
      ok((await SettingsServiceLocal.get("golden.windowMinutes")) === 15, "default golden window is 15 minutes");
      ok((await SettingsServiceLocal.get("golden.workStartHour")) === 11, "default working hours start 11:00 IST");
      ok((await SettingsServiceLocal.get("golden.workEndHour")) === 19, "default working hours end 19:00 IST");
      ok((await SettingsServiceLocal.get("kiara.welcomeTemplateName")) === "", "safety net ships DORMANT (no template)");
      if (stored.length) await Setting.insertMany(stored.map(({ _id, ...rest }) => rest));
      SettingsServiceLocal.invalidate ? SettingsServiceLocal.invalidate() : null;
    }

    section("S5: dormant when unset");
    // Force "outside working hours" so the after-hours branch WOULD fire if armed.
    const istHr = new Date(Date.now() + 330 * 60 * 1000).getUTCHours();
    const offS = istHr >= 22 ? 0 : istHr + 1;
    const offE = istHr >= 22 ? 1 : istHr + 2;
    await api("PUT", "/settings", { token: founderToken, body: { key: "golden.workStartHour", value: offS } });
    await api("PUT", "/settings", { token: founderToken, body: { key: "golden.workEndHour", value: offE } });
    const metaBefore = mock.metaCalls.length;
    const pS1 = phone(301);
    const dormantCreate = await api("POST", "/enquiry", {
      body: { name: "MB56 Dormant Lead", phone: pS1, source: "Website", verified: false },
    });
    ok(dormantCreate.status === 201, "after-hours lead created (safety net unset)");
    await sleep(1200);
    ok(mock.metaCalls.length === metaBefore, "DORMANT: no template sent when kiara.welcomeTemplateName is unset");
    ok(!(await WAConversation.findOne({ phone: `91${pS1.slice(-10)}` }).lean()) &&
       !(await WAConversation.findOne({ phone: pS1 }).lean()),
       "DORMANT: no conversation opened");

    section("S5: after-hours create → welcome template + conversation");
    await api("PUT", "/settings", {
      token: founderToken,
      body: { key: "kiara.welcomeTemplateName", value: "wedsy_welcome_v1" },
    });
    const pS2 = phone(302);
    const ahCreate = await api("POST", "/enquiry", {
      body: { name: "MB56 AfterHours Lead", phone: pS2, source: "Website", verified: false },
    });
    ok(ahCreate.status === 201, "after-hours lead created (armed)");
    const ahLead = await waitFor(async () => {
      const l = await Enquiry.findOne({ phone: pS2 }).lean();
      return l && l.kiaraSafetyNetAt ? l : null;
    }, "safety net engaged");
    ok(!!ahLead.kiaraSafetyNetAt, "kiaraSafetyNetAt stamped (once-per-lead marker)");
    const tplCall = mock.metaCalls.find(
      (m) => m.body.type === "template" && m.body.template && m.body.template.name === "wedsy_welcome_v1" && m.body.to === pS2
    );
    ok(!!tplCall && tplCall.phoneNumberId === "MB56_AGENT", "welcome template sent from KIARA's number");
    const ahConv = await WAConversation.findOne({ phone: pS2 }).lean();
    ok(!!ahConv && ahConv.mode === "ai" && String(ahConv.enquiryId) === String(ahLead._id), "ai-mode conversation opened + linked");
    ok(
      !!(await LeadInternalEvent.findOne({ leadId: ahLead._id, type: "kiara_safety_net_engaged", "payload.reason": "after_hours_create" }).lean()),
      "journey event kiara_safety_net_engaged (after_hours_create)"
    );
    ok(
      !!(await WAAgentMessage.findOne({ phone: pS2, message: "[template: wedsy_welcome_v1]" }).lean()),
      "template placeholder stored in the thread"
    );

    section("S5: morning pile — after-hours lead in triage with transcript");
    await api("PUT", "/settings", { token: founderToken, body: { key: "assignment.mode", value: "triage" } });
    // The after-hours lead was created in AUTO mode (assigned via round-robin);
    // create a fresh one to verify the triage+transcript path.
    const pS3 = phone(303);
    await api("POST", "/enquiry", {
      body: { name: "MB56 MorningPile Lead", phone: pS3, source: "Website", verified: false },
    });
    const mpLead = await waitFor(async () => {
      const l = await Enquiry.findOne({ phone: pS3 }).lean();
      return l && l.kiaraSafetyNetAt ? l : null;
    }, "morning-pile lead engaged");
    ok(mpLead.triagePending === true && mpLead.assignedTo === null, "after-hours lead waits in triage");
    // Back to working hours = "the morning": the pile is visible with transcript.
    await api("PUT", "/settings", { token: founderToken, body: { key: "golden.workStartHour", value: 0 } });
    await api("PUT", "/settings", { token: founderToken, body: { key: "golden.workEndHour", value: 24 } });
    const morningQueue = await api("GET", "/enquiry/triage", { token: holderToken });
    const mpRow = (morningQueue.data.list || []).find((r) => String(r._id) === String(mpLead._id));
    ok(!!mpRow, "morning pile: lead appears in triage at open");
    ok(mpRow && mpRow.transcript.length >= 1 && mpRow.transcript[0].message.includes("wedsy_welcome_v1"),
       "Kiara transcript attached to the pile row");
    await api("POST", `/enquiry/${mpLead._id}/triage-assign`, { token: holderToken });
    await api("PUT", "/settings", { token: founderToken, body: { key: "assignment.mode", value: "auto" } });

    section("S5: in-hours golden-window miss → engage once");
    const pS4 = phone(304);
    await api("POST", "/enquiry", {
      body: { name: "MB56 GW Miss Lead", phone: pS4, source: "Website", verified: false },
    });
    const gwLead = await waitFor(async () => Enquiry.findOne({ phone: pS4 }).lean(), "gw lead created");
    ok(!gwLead.kiaraSafetyNetAt, "in-hours lead NOT engaged at create");
    // Clock-mock: age the lead past the 15-min window (raw collection write —
    // mongoose treats createdAt as immutable and silently strips it).
    await Enquiry.collection.updateOne(
      { _id: gwLead._id },
      { $set: { createdAt: new Date(Date.now() - 30 * 60 * 1000) } }
    );
    await api("GET", "/enquiry/dashboard", { token: founderToken }); // sweep rides the dashboard
    const gwAfter = await waitFor(async () => {
      const l = await Enquiry.findById(gwLead._id).lean();
      return l && l.kiaraSafetyNetAt ? l : null;
    }, "gw miss engaged");
    ok(
      !!(await LeadInternalEvent.findOne({ leadId: gwLead._id, type: "kiara_safety_net_engaged", "payload.reason": "golden_window_missed" }).lean()),
      "journey reason golden_window_missed"
    );
    const gwTplCalls = mock.metaCalls.filter((m) => m.body.type === "template" && m.body.to === pS4).length;
    await api("GET", "/enquiry/dashboard", { token: founderToken }); // second sweep
    await sleep(800);
    const gwTplCalls2 = mock.metaCalls.filter((m) => m.body.type === "template" && m.body.to === pS4).length;
    ok(gwTplCalls === 1 && gwTplCalls2 === 1, "engaged exactly ONCE per lead");

    section("S5: mission-quiet for safety-net leads");
    const dash5 = await api("GET", "/enquiry/dashboard", { token: founderToken });
    ok(
      !(dash5.data.newUntouched || []).some((r) => String(r.leadId || r._id) === String(gwAfter._id)),
      "safety-net-engaged lead joins mission-quiet (absent from new-untouched)"
    );
    // Disarm for the remaining slices.
    await api("PUT", "/settings", { token: founderToken, body: { key: "kiara.welcomeTemplateName", value: "" } });

    // ════ SLICE 6 — Cockpit v2 + scripts-in-settings ════
    section("S6: public settings expose services + scripts");
    const pub = await api("GET", "/settings/public", { token: internToken });
    ok(
      Array.isArray(pub.data["services.available"]) && pub.data["services.available"].includes("Mehendi") && pub.data["services.available"].length === 8,
      "services.available seeded with the 8 services"
    );
    ok(
      ["cockpit.briefScript", "cockpit.servicesScript", "cockpit.budgetScript", "cockpit.qualificationIntro"].every(
        (k) => typeof pub.data[k] === "string" && pub.data[k].length > 50
      ),
      "all four cockpit scripts drafted + readable without settings perms"
    );

    section("S6: qualification v2 fields");
    const leadQ = await Enquiry.create({
      name: `${MARK} CockpitLead`,
      phone: phone(401),
      verified: false,
      source: "Website",
      additionalInfo: {},
      stage: "new",
      assignedTo: intern._id,
    });
    const qPut = await api("PUT", `/enquiry/${leadQ._id}/qualification`, {
      token: internToken,
      body: {
        servicesRequired: ["Decor", "Photography", "Decor"],
        budgetAmount: 1500000,
        budgetNote: "15L ±, flexible for the right venue",
        additionalEmails: ["partner@example.com", "PARTNER@example.com"],
        groomName: "Arjun",
      },
    });
    ok(qPut.status === 200, "qualification PUT accepts the v2 fields");
    const leadQAfter = await Enquiry.findById(leadQ._id).lean();
    ok(
      JSON.stringify(leadQAfter.qualificationData.servicesRequired) === JSON.stringify(["Decor", "Photography"]),
      "servicesRequired deduped + stored"
    );
    ok(leadQAfter.qualificationData.budgetAmount === 1500000 && leadQAfter.qualificationData.budgetNote.includes("15L"), "budget stored (number + note)");
    ok(
      JSON.stringify(leadQAfter.qualificationData.additionalEmails) === JSON.stringify(["partner@example.com"]),
      "additionalEmails lowercased + deduped"
    );
    const qBad = await api("PUT", `/enquiry/${leadQ._id}/qualification`, {
      token: internToken,
      body: { additionalEmails: ["not-an-email"] },
    });
    ok(qBad.status === 400, "invalid additionalEmails rejected (400)");

    section("S6: Kiara servicesRequired/budget map into cockpit fields");
    mock.extractor = {
      qualified: true,
      escalate: false,
      escalateReason: "",
      classification: "lead",
      data: {
        name: "Kiara Mapped",
        eventDate: "",
        servicesRequired: "decor and photography, maybe mehendi",
        budget: "around 12 lakhs",
      },
    };
    const pK = phone(402);
    await signedWebhook(inboundText(pK, "We need help with our wedding!", "Kiara Mapped"));
    const kLead = await waitFor(async () => {
      const c = await WAConversation.findOne({ phone: pK }).lean();
      if (!c || !c.enquiryId) return null;
      const l = await Enquiry.findById(c.enquiryId).lean();
      return l && l.qualified && (l.qualificationData.servicesRequired || []).length ? l : null;
    }, "kiara qualified sync", 40000);
    const mappedServices = kLead.qualificationData.servicesRequired;
    ok(
      mappedServices.includes("Decor") && mappedServices.includes("Photography") && mappedServices.includes("Mehendi"),
      `Kiara services mapped best-effort (${mappedServices.join(",")})`
    );
    ok(kLead.qualificationData.budgetAmount === 1200000, `Kiara budget parsed to 1200000 (got ${kLead.qualificationData.budgetAmount})`);
    ok(kLead.qualificationData.budgetNote === "around 12 lakhs", "raw budget kept as the note");
    mock.extractor = { qualified: false, escalate: false, escalateReason: "", classification: "lead", data: {} };

    section("S6: meet-refuser");
    const refuse = await api("POST", `/enquiry/${leadQ._id}/meet-refused`, { token: internToken });
    ok(refuse.status === 200 && (refuse.data.tags || []).includes("no-meet"), "lead tagged no-meet");
    ok(
      !!(await LeadInternalEvent.findOne({ leadId: leadQ._id, type: "meet_refused" }).lean()),
      "journey event meet_refused"
    );
    ok(
      !!(await AdminNotification.findOne({ adminId: salesLead._id, type: "meet_refused", leadId: leadQ._id }).lean()),
      "sales lead (reporting manager) escalated"
    );
    ok(
      !!(await AdminNotification.findOne({ adminId: revenueHead._id, type: "meet_refused", leadId: leadQ._id }).lean()),
      "Revenue Head notified"
    );

    section("S6: settings_scripts gating");
    const scriptsDenied = await api("GET", "/settings?category=settings_scripts", { token: holderToken });
    ok(scriptsDenied.status === 403, "settings_scripts denied without the permission");
    const scriptsCat = await api("GET", "/settings?category=settings_scripts", { token: founderToken });
    ok(
      scriptsCat.status === 200 && Object.keys(scriptsCat.data.values || {}).length === 4,
      "founder reads the scripts category (4 keys)"
    );
    const scriptPut = await api("PUT", "/settings", {
      token: founderToken,
      body: { key: "cockpit.briefScript", value: "Hi {{name}}, this is {{caller}} — quick test script." },
    });
    ok(scriptPut.status === 200, "script saves through the standard settings PUT");
    const pub2 = await api("GET", "/settings/public", { token: internToken });
    ok(String(pub2.data["cockpit.briefScript"]).includes("quick test script"), "cockpit renders the edited script via settings");
    await Setting.deleteMany({ key: "cockpit.briefScript" }); // restore default

    // ════ SLICE 7 — Instagram hooks (MB4 pattern adapted) ════
    section("S7: IG inbound → channel:'instagram' conversation, unlinked");
    const IG1 = "MB56IG00000001";
    ok((await signedIgWebhook(IG1, "Hi! Do you do engagement decor?")) === 200, "IG webhook accepts signed payload");
    const igConv1 = await waitFor(async () => WAConversation.findOne({ phone: IG1 }).lean(), "IG conversation created");
    ok(igConv1.channel === "instagram", "conversation carries channel:'instagram'");
    ok(igConv1.enquiryId === null, "no phone yet → conversation lives UNLINKED");
    await waitFor(async () => WAAgentMessage.findOne({ phone: IG1, role: "assistant" }).lean(), "IG Kiara replied");
    ok(mock.igCalls.some((c) => c.body.recipient.id === IG1), "reply delivered as an Instagram DM (mock)");
    const igInbox = await api("GET", "/wa/conversations?status=active&limit=100", { token: founderToken });
    const igRow = (igInbox.data.list || []).find((c) => c.phone === IG1);
    ok(!!igRow && igRow.channel === "instagram" && igRow.lead === null, "unlinked IG thread surfaces in the inbox, badged by channel");

    section("S7: IG mode gate — takeover silences the bot identically");
    const takeIg = await api("POST", `/wa/conversations/${igConv1._id}/takeover`, { token: founderToken });
    ok(takeIg.status === 200 && takeIg.data.mode === "human", "takeover works on IG threads");
    const igCallsBefore = mock.anthropicCalls.length;
    const igMsgsBefore = await WAAgentMessage.countDocuments({ phone: IG1, role: "assistant" });
    await signedIgWebhook(IG1, "hello? anyone there?");
    await waitFor(async () => WAAgentMessage.findOne({ phone: IG1, message: "hello? anyone there?" }).lean(), "human-mode IG inbound stored");
    await sleep(1200);
    ok(mock.anthropicCalls.length === igCallsBefore, "NO Anthropic call in human mode (IG)");
    ok((await WAAgentMessage.countDocuments({ phone: IG1, role: "assistant" })) === igMsgsBefore, "NO auto-reply in human mode (IG)");
    const igDmsBefore = mock.igCalls.length;
    const igSend = await api("POST", `/wa/conversations/${igConv1._id}/send`, {
      token: founderToken,
      body: { text: "Hi! This is the Wedsy team — happy to help directly." },
    });
    ok(igSend.status === 200, "admin send works on IG threads");
    ok(mock.igCalls.length === igDmsBefore + 1 && mock.metaCalls.every((m) => m.body.to !== IG1), "admin send goes out as an IG DM, never WhatsApp");
    const igTpl = await api("POST", `/wa/conversations/${igConv1._id}/send-template`, { token: founderToken });
    ok(igTpl.status === 422, "re-engage template blocked on IG (WhatsApp-only feature)");
    const backIg = await api("POST", `/wa/conversations/${igConv1._id}/handback`, { token: founderToken });
    ok(backIg.status === 200 && backIg.data.mode === "ai", "handback resumes the IG bot");

    section("S7: IG escalation contract");
    const IG2 = "MB56IG00000002";
    mock.extractor = { qualified: false, escalate: true, escalateReason: "Customer wants a human", classification: "lead", data: {} };
    await signedIgWebhook(IG2, "I want to talk to a real person please");
    const igConv2 = await waitFor(async () => {
      const c = await WAConversation.findOne({ phone: IG2 }).lean();
      return c && c.needsHuman ? c : null;
    }, "IG escalation flips needsHuman");
    ok(igConv2.needsHuman && igConv2.needsHumanReason === "Customer wants a human", "escalation reason recorded");
    mock.extractor = { qualified: false, escalate: false, escalateReason: "", classification: "lead", data: {} };

    section("S7: IG phone capture → CRM linkage + qualified sync");
    const IG3 = "MB56IG00000003";
    mock.extractor = {
      qualified: true,
      escalate: true,
      escalateReason: "Qualified — ready for your call",
      classification: "lead",
      data: {
        name: "Insta Bride",
        phoneNumber: "9191000505",
        eventType: "wedding",
        city: "Bengaluru",
        servicesRequired: "decor and catering",
        budget: "20 lakhs",
      },
    };
    await signedIgWebhook(IG3, "Sure, my number is 9191000505");
    const igConv3 = await waitFor(async () => {
      const c = await WAConversation.findOne({ phone: IG3 }).lean();
      return c && c.enquiryId ? c : null;
    }, "IG conversation linked once phone captured", 40000);
    const igLead = await Enquiry.findById(igConv3.enquiryId).lean();
    ok(igLead.source === "instagram" && igLead.phone === "919191000505", "CRM lead created with source instagram + real phone");
    ok(
      !!(await LeadInternalEvent.findOne({ leadId: igLead._id, type: "ig_conversation_linked" }).lean()),
      "journey event ig_conversation_linked"
    );
    await waitFor(async () => {
      const l = await Enquiry.findById(igLead._id).lean();
      return l.qualified ? l : null;
    }, "IG qualified sync");
    ok(
      !!(await LeadInternalEvent.findOne({ leadId: igLead._id, type: "ig_qualified_by_kiara" }).lean()),
      "journey event ig_qualified_by_kiara"
    );
    const igLeadFinal = await Enquiry.findById(igLead._id).lean();
    ok(
      (igLeadFinal.qualificationData.servicesRequired || []).includes("Decor") &&
        (igLeadFinal.qualificationData.servicesRequired || []).includes("Catering"),
      "IG services mapped into cockpit fields"
    );
    ok(igLeadFinal.qualificationData.budgetAmount === 2000000, "IG budget parsed (20 lakhs → 2000000)");
    const igQl = await QualifiedLead.findOne({ phone: IG3 }).lean();
    ok(!!igQl && igQl.crmSynced === true, "QualifiedLead.crmSynced mirrors the WA idiom");
    mock.extractor = { qualified: false, escalate: false, escalateReason: "", classification: "lead", data: {} };
  } catch (e) {
    failed++;
    failures.push(`fatal: ${e.message}`);
    console.error("FATAL:", e);
    console.error("server log tail:", serverLog.slice(-2000));
  } finally {
    section("Cleanup");
    const leads = await Enquiry.find(
      { phone: { $regex: `^(${PHONE_PREFIX}|919191000)` } },
      { _id: 1 }
    ).lean();
    const leadIds = leads.map((l) => l._id);
    await LeadInternalEvent.deleteMany({ leadId: { $in: leadIds } });
    await Enquiry.deleteMany({ phone: { $regex: `^(${PHONE_PREFIX}|919191000)` } });
    await WAConversation.deleteMany({ phone: { $regex: `^(${PHONE_PREFIX}|MB56IG)` } });
    await WAAgentMessage.deleteMany({ phone: { $regex: `^(${PHONE_PREFIX}|MB56IG)` } });
    await QualifiedLead.deleteMany({ phone: { $regex: `^(${PHONE_PREFIX}|MB56IG)` } });
    await NotificationFailureLog.deleteMany({ phone: { $regex: `^(${PHONE_PREFIX}|MB56IG)` } });
    const VendorContact = require("../models/VendorContact");
    await VendorContact.deleteMany({ phone: { $regex: `^(${PHONE_PREFIX}|MB56IG)` } });
    await Attendance.deleteMany({ adminId: { $in: [founder._id, salesLead._id, intern._id] } });
    const allAdminIds = [founder._id, salesLead._id, intern._id, holder._id, revenueHead._id];
    const CalendarEventModel = require("../models/CalendarEvent");
    const AdminNotificationModel = require("../models/AdminNotification");
    await CalendarEventModel.deleteMany({ ownerId: { $in: allAdminIds } });
    await AdminNotificationModel.deleteMany({ adminId: { $in: allAdminIds } });
    await Attendance.deleteMany({ adminId: { $in: allAdminIds } });
    await Admin.deleteMany({ _id: { $in: allAdminIds } });
    await Role.deleteMany({ _id: { $in: [founderRole._id, salesLeadRole._id, internRole._id, holderRole._id] } });
    if (rhRoleCreated) await Role.deleteMany({ _id: rhRole._id });
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
