/* Kiara ↔ Wedsy OS — end-to-end suite (MEGA-BUILD 4 verify).
 *
 * Boots the real server on a TEST port with the Anthropic + Meta Graph calls
 * pointed at an in-process mock (ANTHROPIC_API_URL / META_GRAPH_BASE_URL) and
 * Google Sheets creds forced bogus, then drives it with HMAC-SIGNED webhook
 * payloads and the admin chat API. Never touches a live API. Local DB only.
 * Cleans every fixture it creates.
 *
 * Run: node scripts/e2e-kiara.js
 */
require("dotenv").config();
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const APP_PORT = 8097;
const MOCK_PORT = 8098;
const BASE = `http://localhost:${APP_PORT}`;
const APP_SECRET = process.env.WHATSAPP_AGENT_APP_SECRET || "kiara-e2e-secret";
const AGENT_PHONE_ID = "KIARA_E2E_AGENT_ID";
const PHONE_PREFIX = "9190000"; // every test phone starts with this
const startedAt = new Date();

// ── Tiny test harness ─────────────────────────────────────────────────────────
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

// ── Mock Anthropic + Meta Graph server ────────────────────────────────────────
const mock = {
  anthropicCalls: [], // { system, messages }
  metaCalls: [], // { phoneNumberId, body }
  replyText: "Lovely! Tell me a little more 😊",
  extractor: { qualified: false, escalate: false, escalateReason: "", classification: "lead", data: {} },
  anthropicMode: "normal", // normal | empty | toolFirst
};
const mockServer = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    if (req.url === "/v1/messages") {
      mock.anthropicCalls.push({ system: body.system, messages: body.messages });
      let content;
      if (mock.anthropicMode === "empty") {
        content = [];
      } else if (mock.anthropicMode === "toolFirst") {
        content = [
          { type: "tool_use", id: "tu_1", name: "x", input: {} },
          { type: "text", text: "Reply after a tool block 🛠" },
        ];
      } else if (String(body.system || "").startsWith("You are a data extractor")) {
        content = [{ type: "text", text: JSON.stringify(mock.extractor) }];
      } else {
        content = [{ type: "text", text: mock.replyText }];
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "msg_e2e", content, stop_reason: "end_turn" }));
      return;
    }
    const graph = req.url.match(/^\/graph\/([^/]+)\/messages$/);
    if (graph) {
      mock.metaCalls.push({ phoneNumberId: graph[1], body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: "wamid.e2e" }] }));
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

const inboundText = (phone, text, profileName = "E2E Customer") => ({
  entry: [
    {
      changes: [
        {
          value: {
            contacts: [{ profile: { name: profileName }, wa_id: phone }],
            messages: [{ from: phone, id: `wamid.in.${Date.now()}`, type: "text", text: { body: text } }],
          },
        },
      ],
    },
  ],
});

const inboundMedia = (phone, type = "image", profileName = "E2E Customer") => ({
  entry: [
    {
      changes: [
        {
          value: {
            contacts: [{ profile: { name: profileName }, wa_id: phone }],
            messages: [{ from: phone, id: `wamid.in.${Date.now()}`, type, [type]: { id: "media-1" } }],
          },
        },
      ],
    },
  ],
});

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  if (!process.env.DATABASE_URL || !process.env.JWT_SECRET) {
    console.error("DATABASE_URL / JWT_SECRET missing — run from the repo root with .env present.");
    process.exit(1);
  }
  await mongoose.connect(process.env.DATABASE_URL);
  const Enquiry = require("../models/Enquiry");
  const WAConversation = require("../models/WAConversation");
  const WAAgentMessage = require("../models/WAAgentMessage");
  const QualifiedLead = require("../models/QualifiedLead");
  const VendorContact = require("../models/VendorContact");
  const LeadInternalEvent = require("../models/LeadInternalEvent");
  const NotificationFailureLog = require("../models/NotificationFailureLog");
  const ActivityLog = require("../models/ActivityLog");
  const Setting = require("../models/Setting");
  const Admin = require("../models/Admin");
  const Role = require("../models/Role");
  const User = require("../models/User");
  const Event = require("../models/Event");

  // Fixtures: department + roles + admins + assignment pool routed at the intern.
  const Department = require("../models/Department");
  const dept = await Department.create({ name: "KIARA-E2E Dept" });
  const founderRole = await Role.create({
    name: "KIARA-E2E Founder",
    departmentId: dept._id,
    permissions: ["*:*:all"],
  });
  const internRole = await Role.create({
    name: "KIARA-E2E Intern",
    departmentId: dept._id,
    permissions: ["leads:view:own", "leads:edit:own"],
  });
  const founder = await Admin.create({
    name: "Kiara E2E Founder",
    email: `kiara-e2e-founder-${Date.now()}@test.local`,
    phone: "919000090001",
    password: "kiara-e2e-not-a-real-password",
    roles: ["crm"],
    roleId: founderRole._id,
    departmentId: dept._id,
    status: "active",
  });
  const intern = await Admin.create({
    name: "Kiara E2E Intern",
    email: `kiara-e2e-intern-${Date.now()}@test.local`,
    phone: "919000090002",
    password: "kiara-e2e-not-a-real-password",
    roles: ["sales"],
    roleId: internRole._id,
    departmentId: dept._id,
    status: "active",
  });
  const founderToken = jwt.sign({ _id: String(founder._id), isAdmin: true }, process.env.JWT_SECRET);
  const internToken = jwt.sign({ _id: String(intern._id), isAdmin: true }, process.env.JWT_SECRET);

  // Snapshot any pre-existing settings we touch so cleanup restores them.
  const touchedKeys = ["assignment.poolRoles", "kiara.systemPrompt", "kiara.reengageTemplateName"];
  const settingsBefore = await Setting.find({ key: { $in: touchedKeys } }).lean();

  // Boot mock + server.
  await new Promise((r) => mockServer.listen(MOCK_PORT, r));
  const child = spawn("node", ["server.js"], {
    cwd: `${__dirname}/..`,
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      ANTHROPIC_API_URL: `http://localhost:${MOCK_PORT}/v1/messages`,
      META_GRAPH_BASE_URL: `http://localhost:${MOCK_PORT}/graph`,
      WHATSAPP_AGENT_PHONE_NUMBER_ID: AGENT_PHONE_ID,
      WHATSAPP_AGENT_APP_SECRET: APP_SECRET,
      META_WA_AGENT_ACCESS_TOKEN: "e2e-agent-token",
      GOOGLE_SHEETS_KEY_PATH: "/nonexistent/kiara-e2e-keyfile.json",
      GOOGLE_SHEETS_ID: "kiara-e2e-sheet",
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
    await waitFor(
      () => fetch(`${BASE}/`).then((r) => r.ok).catch(() => false),
      "server boot",
      30000
    );

    // Route auto-assignment at the e2e intern only.
    const poolPut = await api("PUT", "/settings", {
      token: founderToken,
      body: { key: "assignment.poolRoles", value: ["KIARA-E2E Intern"] },
    });
    ok(poolPut.status === 200, "settings: assignment pool routed at e2e intern");

    // ── (1) First inbound from an unknown number ────────────────────────────
    section("1. First inbound → conversation + lead + mission-quiet");
    const p1 = phone(1);
    ok((await signedWebhook(inboundText(p1, "Hi! Planning my wedding"))) === 200, "webhook accepts signed payload");
    const conv1 = await waitFor(async () => {
      const c = await WAConversation.findOne({ phone: p1 }).lean();
      return c && c.enquiryId ? c : null;
    }, "conversation + lead link");
    const lead1 = await Enquiry.findById(conv1.enquiryId).lean();
    ok(!!lead1, "Enquiry created");
    ok(lead1.source === "whatsapp", "lead source is 'whatsapp'");
    ok(lead1.name === "E2E Customer", "lead named from webhook profile.name");
    ok(String(lead1.assignedTo) === String(intern._id), "lead auto-assigned (round-robin pool)");
    ok(conv1.mode === "ai" && conv1.status === "active", "conversation defaults: ai/active");
    ok(conv1.unreadCount >= 1, "unread bumped");
    const ev1 = await LeadInternalEvent.findOne({ leadId: lead1._id, type: "wa_conversation_started" }).lean();
    ok(!!ev1, "journey event wa_conversation_started");
    await waitFor(async () => WAAgentMessage.findOne({ phone: p1, role: "assistant" }).lean(), "Kiara replied");
    ok(
      mock.metaCalls.some((m) => m.phoneNumberId === AGENT_PHONE_ID && m.body.to === p1 && m.body.type === "text"),
      "reply sent via the AGENT phone number id"
    );
    // Unsigned payload is rejected.
    const badSig = await fetch(`${BASE}/webhook/whatsapp-agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-hub-signature-256": "sha256=deadbeef" },
      body: JSON.stringify(inboundText(p1, "spoof")),
    });
    ok(badSig.status === 403, "tampered signature rejected (403)");

    const dash1 = await api("GET", "/enquiry/dashboard", { token: founderToken });
    ok(dash1.status === 200, "dashboard loads");
    ok(
      !(dash1.data.newUntouched || []).some((r) => String(r.leadId) === String(lead1._id)),
      "mission-quiet: Kiara-handled lead absent from new-untouched call pressure"
    );

    // ── (2) Takeover silences Kiara; handback resumes ───────────────────────
    section("2. Takeover → no AI call; handback → resumes");
    const take = await api("POST", `/wa/conversations/${conv1._id}/takeover`, { token: founderToken });
    ok(take.status === 200 && take.data.mode === "human", "takeover → mode human");
    const callsBefore = mock.anthropicCalls.length;
    const msgsBefore = await WAAgentMessage.countDocuments({ phone: p1, role: "assistant" });
    await signedWebhook(inboundText(p1, "are you a real person?"));
    await waitFor(async () => WAAgentMessage.findOne({ phone: p1, message: "are you a real person?" }).lean(), "human-mode inbound stored");
    await sleep(1500);
    ok(mock.anthropicCalls.length === callsBefore, "NO Anthropic call in human mode (spy)");
    ok(
      (await WAAgentMessage.countDocuments({ phone: p1, role: "assistant" })) === msgsBefore,
      "NO auto-reply in human mode"
    );
    ok(
      !!(await LeadInternalEvent.findOne({ leadId: lead1._id, type: "wa_human_takeover" }).lean()),
      "journey event wa_human_takeover"
    );
    const back = await api("POST", `/wa/conversations/${conv1._id}/handback`, { token: founderToken });
    ok(back.status === 200 && back.data.mode === "ai", "handback → mode ai");
    await signedWebhook(inboundText(p1, "ok continuing"));
    await waitFor(
      async () => (await WAAgentMessage.countDocuments({ phone: p1, role: "assistant" })) > msgsBefore,
      "Kiara resumes after handback"
    );
    ok(true, "Kiara resumed after handback");

    // MB6 Slice 11: the extractor is SKIPPED until a conversation has 3 user
    // messages — extraction sections prime with the decisive message first
    // (firstMessage assertions depend on it), then two fillers.
    const sendThree = async (p, decisiveText, profileName = "E2E Customer") => {
      await signedWebhook(inboundText(p, decisiveText, profileName));
      await waitFor(
        async () => (await WAAgentMessage.countDocuments({ phone: p, role: "assistant" })) >= 1,
        "priming reply 1"
      );
      await signedWebhook(inboundText(p, "ok — anything else you need from me?", profileName));
      await waitFor(
        async () => (await WAAgentMessage.countDocuments({ phone: p, role: "assistant" })) >= 2,
        "priming reply 2"
      );
      await signedWebhook(inboundText(p, "that's everything from my side!", profileName));
    };

    // ── (3) Escalation ───────────────────────────────────────────────────────
    section("3. Escalation JSON → needsHuman + mission card + journey");
    const p3 = phone(3);
    mock.extractor = { qualified: false, escalate: true, escalateReason: "Customer is frustrated", classification: "lead", data: {} };
    await sendThree(p3, "This is taking forever. Get me a human!");
    const conv3 = await waitFor(async () => {
      const c = await WAConversation.findOne({ phone: p3 }).lean();
      return c && c.needsHuman ? c : null;
    }, "escalation flag");
    ok(conv3.needsHuman === true, "needsHuman set");
    ok(conv3.needsHumanReason === "Customer is frustrated", "needsHumanReason carried");
    ok(
      !!(await LeadInternalEvent.findOne({ leadId: conv3.enquiryId, type: "wa_escalated" }).lean()),
      "journey event wa_escalated"
    );
    const dash3 = await api("GET", "/enquiry/dashboard", { token: founderToken });
    ok(
      (dash3.data.waNeedsHuman || []).some((r) => String(r.conversationId) === String(conv3._id)),
      "dashboard mission card (waNeedsHuman) present"
    );
    ok(
      (dash3.data.waNeedsHuman || []).some((r) => r.reason === "Customer is frustrated"),
      "mission card carries the reason"
    );
    ok(
      (dash3.data.newUntouched || []).some((r) => String(r.leadId) === String(conv3.enquiryId)),
      "escalated lead re-enters call-now pressure (no longer quiet)"
    );

    // ── (4) Qualification → CRM sync (Sheets failing → independence) ────────
    section("4. Qualified JSON → CRM sync independent of Sheets");
    const p4 = phone(4);
    mock.extractor = {
      qualified: true,
      escalate: true,
      escalateReason: "Qualified — ready for your call",
      classification: "lead",
      data: {
        name: "Asha Rao",
        eventType: "wedding",
        city: "Bengaluru",
        eventDate: "2026-11-20",
        numberOfEvents: "3",
        venueStatus: "booked",
        venueName: "Taj West End",
        servicesRequired: "decor only",
        budget: "5L",
        weddingStyle: "South Indian",
      },
    };
    await sendThree(p4, "Thanks! All details shared.", "Asha Rao");
    const ql4 = await waitFor(async () => {
      const q = await QualifiedLead.findOne({ phone: p4 }).lean();
      return q && q.crmSynced ? q : null;
    }, "QualifiedLead crmSynced", 30000);
    ok(ql4.crmSynced === true, "crmSynced true");
    ok(ql4.googleSheetSynced === false, "googleSheetSynced false (Sheets mock-failed) → INDEPENDENCE proven");
    ok(
      !!(await NotificationFailureLog.findOne({ service: "GoogleSheets", phone: p4 }).lean()),
      "Sheets failure logged through the existing FailureLog path"
    );
    const conv4 = await WAConversation.findOne({ phone: p4 }).lean();
    const lead4 = await Enquiry.findById(conv4.enquiryId).lean();
    ok(lead4.qualified === true, "lead qualified flag set (Roadmap shows Qualified ✓ — derived from this flag)");
    ok(lead4.qualificationData.venueName === "Taj West End", "qualificationData.venueName mapped");
    ok(lead4.qualificationData.venueStatus === "booked", "qualificationData.venueStatus normalized to 'booked'");
    ok(lead4.qualificationData.weddingStyle === "South Indian", "qualificationData.weddingStyle mapped");
    ok(lead4.qualificationData.groomName === "Asha Rao", "name surfaced as couple fact (both names were empty)");
    const ka = lead4.additionalInfo && lead4.additionalInfo.kiaraAnswers;
    ok(!!ka && Object.keys(ka).length === 10, "ALL ten raw answers under additionalInfo.kiaraAnswers");
    ok(ka && ka.budget === "5L" && ka.servicesRequired === "decor only", "kiaraAnswers carry budget + services raw");
    const user4 = await User.findOne({ phone: p4 }).lean();
    ok(!!user4, "Event Store user created");
    const event4 = user4 ? await Event.findOne({ user: user4._id }).lean() : null;
    ok(!!event4 && event4.eventDays.length === 3, "Event created with 3 eventDays");
    ok(event4 && event4.eventDays[0].date === "2026-11-20" && event4.eventDays[2].date === "2026-11-22", "eventDays anchored on parsed date");
    ok(
      !!(await LeadInternalEvent.findOne({ leadId: lead4._id, type: "wa_qualified_by_kiara" }).lean()),
      "journey event wa_qualified_by_kiara"
    );
    ok(conv4.needsHuman && conv4.needsHumanReason === "Qualified — ready for your call", "qualified ⇒ ALWAYS escalates with the canonical reason");
    const journey4 = await api("GET", `/enquiry/${lead4._id}/journey`, { token: founderToken });
    ok(
      (journey4.data.entries || []).some((e) => e.type === "wa_qualified_by_kiara" && e.title === "Qualified by Kiara ✦"),
      "journey API titles the Kiara qualification"
    );

    // ── (5) Vendor classification ────────────────────────────────────────────
    section("5. Vendor JSON → VendorContact + conversation closed + lead lost");
    const p5 = phone(5);
    mock.extractor = {
      qualified: false,
      escalate: false,
      escalateReason: "",
      classification: "vendor",
      data: { name: "Studio Lumière", servicesRequired: "wedding photography" },
    };
    await sendThree(p5, "Hi, I'm a photographer — can I work with Wedsy?", "Studio Lumiere");
    const conv5 = await waitFor(async () => {
      const c = await WAConversation.findOne({ phone: p5 }).lean();
      return c && c.status === "closed" ? c : null;
    }, "vendor conversation closed");
    ok(conv5.classification === "vendor", "classification stored");
    const vc = await VendorContact.findOne({ phone: p5 }).lean();
    ok(!!vc, "VendorContact captured");
    ok(vc && vc.offering === "wedding photography", "VendorContact offering");
    ok(vc && /photographer/.test(vc.firstMessage), "VendorContact firstMessage = first user message");
    const lead5 = await Enquiry.findById(conv5.enquiryId).lean();
    ok(lead5.stage === "lost" && lead5.isLost === true, "lead closed via lost flow");
    ok(lead5.lostReason === "Not a lead — vendor", "lost reason 'Not a lead — vendor'");
    ok(lead5.lostStatus === "approved", "approval bypassed as system action");
    // Stored-but-silent: another inbound on the closed conversation.
    const calls5 = mock.anthropicCalls.length;
    await signedWebhook(inboundText(p5, "any update?"));
    await waitFor(async () => WAAgentMessage.findOne({ phone: p5, message: "any update?" }).lean(), "closed-conv inbound stored");
    await sleep(1000);
    ok(mock.anthropicCalls.length === calls5, "closed conversation → zero Anthropic spend");

    // ── (6) Non-text inbound ─────────────────────────────────────────────────
    section("6. Non-text inbound → placeholder, no AI");
    const p6 = phone(6);
    mock.extractor = { qualified: false, escalate: false, escalateReason: "", classification: "lead", data: {} };
    const calls6 = mock.anthropicCalls.length;
    await signedWebhook(inboundMedia(p6, "image"));
    const m6 = await waitFor(async () => WAAgentMessage.findOne({ phone: p6 }).lean(), "media placeholder stored");
    ok(m6.message === "[media: image]", "placeholder message '[media: image]'");
    const conv6 = await WAConversation.findOne({ phone: p6 }).lean();
    ok(!!conv6 && conv6.unreadCount === 1, "conversation upserted + unread++");
    ok(!!conv6.enquiryId, "lead ensured for media-first contact");
    await sleep(1200);
    ok(mock.anthropicCalls.length === calls6, "NO AI call for media");
    ok((await WAAgentMessage.countDocuments({ phone: p6, role: "assistant" })) === 0, "NO reply for media");

    // ── (7) 24h window: send / 422 / send-template ──────────────────────────
    section("7. 24h window enforcement + re-engage template");
    // 409 while AI-owned:
    const send409 = await api("POST", `/wa/conversations/${conv1._id}/send`, { token: founderToken, body: { text: "hi" } });
    ok(send409.status === 409, "send in AI mode → 409 (take over first)");
    await api("POST", `/wa/conversations/${conv1._id}/takeover`, { token: founderToken });
    const sendOk = await api("POST", `/wa/conversations/${conv1._id}/send`, { token: founderToken, body: { text: "Hello from the team!" } });
    ok(sendOk.status === 200, "send inside the window → 200");
    const sentMsg = await WAAgentMessage.findOne({ phone: p1, message: "Hello from the team!" }).lean();
    ok(!!sentMsg && sentMsg.role === "assistant" && String(sentMsg.sentBy) === String(founder._id), "saved as assistant + sentBy admin ref");
    ok(
      mock.metaCalls.some((m) => m.phoneNumberId === AGENT_PHONE_ID && m.body.text && m.body.text.body === "Hello from the team!"),
      "sent via agent number (Meta mocked)"
    );
    // Stale the window.
    await WAConversation.updateOne({ _id: conv1._id }, { $set: { lastInboundAt: new Date(Date.now() - 25 * 3600 * 1000) } });
    const send422 = await api("POST", `/wa/conversations/${conv1._id}/send`, { token: founderToken, body: { text: "too late" } });
    ok(send422.status === 422 && send422.data.windowClosed === true, "send after 24h → 422 {windowClosed:true}");
    // Template not configured yet → 422.
    const tpl422 = await api("POST", `/wa/conversations/${conv1._id}/send-template`, { token: founderToken });
    ok(tpl422.status === 422, "send-template without a configured template → 422");
    const tplSet = await api("PUT", "/settings", { token: founderToken, body: { key: "kiara.reengageTemplateName", value: "kiara_reengage_e2e" } });
    ok(tplSet.status === 200, "founder sets kiara.reengageTemplateName");
    const tplOk = await api("POST", `/wa/conversations/${conv1._id}/send-template`, { token: founderToken });
    ok(tplOk.status === 200, "send-template with window closed → 200");
    ok(
      mock.metaCalls.some(
        (m) =>
          m.phoneNumberId === AGENT_PHONE_ID &&
          m.body.type === "template" &&
          m.body.template &&
          m.body.template.name === "kiara_reengage_e2e"
      ),
      "template sent via agent number with the configured name"
    );

    // ── (8) Crash-fix: empty content + tool-block-first ──────────────────────
    section("8. Crash fix (content[0].text guard)");
    const p8 = phone(8);
    mock.anthropicMode = "empty";
    const failLogsBefore = await NotificationFailureLog.countDocuments({ service: "Anthropic", createdAt: { $gte: startedAt } });
    await signedWebhook(inboundText(p8, "hello?"));
    await waitFor(
      async () =>
        (await NotificationFailureLog.countDocuments({ service: "Anthropic", createdAt: { $gte: startedAt } })) > failLogsBefore,
      "empty-content lands in the FailureLog retry path",
      30000
    );
    ok(true, "empty content array → graceful failure (no crash, FailureLog written)");
    ok((await WAAgentMessage.countDocuments({ phone: p8, role: "assistant" })) === 0, "no reply on empty content");
    ok((await fetch(`${BASE}/`).then((r) => r.ok)), "server alive after empty-content responses");
    mock.anthropicMode = "toolFirst";
    await signedWebhook(inboundText(p8, "you there?"));
    await waitFor(
      async () => WAAgentMessage.findOne({ phone: p8, role: "assistant", message: "Reply after a tool block 🛠" }).lean(),
      "tool-block-first reply extracted"
    );
    ok(true, "tool-block-first response → first TEXT block used");
    mock.anthropicMode = "normal";

    // ── (9) Settings prompt edit reaches the next call ───────────────────────
    section("9. kiara.systemPrompt edit → next call uses it");
    const NEW_PROMPT = "You are KIARA-E2E-TEST persona. Reply tersely.";
    const promptPut = await api("PUT", "/settings", { token: founderToken, body: { key: "kiara.systemPrompt", value: NEW_PROMPT } });
    ok(promptPut.status === 200, "founder saves a new persona");
    const p9 = phone(9);
    await signedWebhook(inboundText(p9, "hi kiara"));
    await waitFor(async () => WAAgentMessage.findOne({ phone: p9, role: "assistant" }).lean(), "reply under new persona");
    const personaCalls = mock.anthropicCalls.filter((c) => !String(c.system || "").startsWith("You are a data extractor"));
    ok(personaCalls[personaCalls.length - 1].system === NEW_PROMPT, "Anthropic call used the EDITED system prompt");
    // RBAC on the settings category: intern may not read or write kiara.*
    const internRead = await api("GET", "/settings?category=settings_kiara", { token: internToken });
    const internWrite = await api("PUT", "/settings", { token: internToken, body: { key: "kiara.systemPrompt", value: "hacked" } });
    ok(internRead.status === 403 && internWrite.status === 403, "settings_kiara is founder-gated (intern 403)");

    // ── (10) RBAC scope on conversations ─────────────────────────────────────
    section("10. RBAC: intern sees only own-lead conversations");
    // Move lead3 to the founder so it leaves the intern's scope.
    await Enquiry.updateOne({ _id: conv3.enquiryId }, { $set: { assignedTo: founder._id } });
    const internInbox = await api("GET", "/wa/conversations", { token: internToken });
    ok(internInbox.status === 200, "intern can open the inbox");
    const internIds = (internInbox.data.list || []).map((c) => String(c._id));
    ok(internIds.includes(String(conv1._id)), "intern sees their own lead's conversation");
    ok(!internIds.includes(String(conv3._id)), "intern does NOT see another owner's conversation");
    const internForeign = await api("GET", `/wa/conversations/${conv3._id}/messages`, { token: internToken });
    ok(internForeign.status === 403, "intern blocked from a foreign thread (403)");
    const founderInbox = await api("GET", "/wa/conversations", { token: founderToken });
    ok(
      (founderInbox.data.list || []).some((c) => String(c._id) === String(conv3._id)),
      "all-scope caller sees everything"
    );
    ok(
      (founderInbox.data.list || []).findIndex((c) => c.needsHuman) <
        (founderInbox.data.list || []).findIndex((c) => !c.needsHuman),
      "inbox sorts needsHuman first"
    );

    // ── (11) Regression: lifecycle + cockpit + dashboard refresh ────────────
    section("11. Regression — cockpit, lifecycle, dashboard, journey");
    const regLead = await Enquiry.create({
      name: "Kiara E2E Regression",
      phone: phone(11),
      source: "Default",
      verified: false,
      assignedTo: intern._id,
    });
    const callLog = await api("POST", `/enquiry/${regLead._id}/call-log`, {
      token: internToken,
      body: { startedAt: new Date().toISOString(), durationSeconds: 60, connected: true, outcome: "qualified", notes: "good call" },
    });
    ok(callLog.status === 200, "cockpit: call-log accepted");
    ok((await Enquiry.findById(regLead._id).lean()).qualified === true, "cockpit: qualified flag flips");
    const qualPut = await api("PUT", `/enquiry/${regLead._id}/qualification`, {
      token: internToken,
      body: { groomName: "R", brideName: "S" },
    });
    ok(qualPut.status === 200, "cockpit: qualification PUT works");
    const fu = await api("POST", `/enquiry/${regLead._id}/follow-up`, {
      token: internToken,
      body: { type: "call", scheduledAt: new Date(Date.now() + 3600e3).toISOString(), promiseNote: "callback" },
    });
    ok(fu.status === 200, "lifecycle: follow-up booked");
    const fuId = (await Enquiry.findById(regLead._id).lean()).followUps[0]._id;
    const badComplete = await api("PUT", `/enquiry/${regLead._id}/follow-up/${fuId}/complete`, {
      token: internToken,
      body: { outcome: "connected" },
    });
    ok(badComplete.status === 422, "lifecycle: zero-orphan gate still enforced (422)");
    const goodComplete = await api("PUT", `/enquiry/${regLead._id}/follow-up/${fuId}/complete`, {
      token: internToken,
      body: {
        outcome: "connected",
        nextFollowUp: { type: "call", scheduledAt: new Date(Date.now() + 7200e3).toISOString() },
      },
    });
    ok(goodComplete.status === 200, "lifecycle: completion with next step works");
    const regJourney = await api("GET", `/enquiry/${regLead._id}/journey`, { token: internToken });
    ok(
      regJourney.status === 200 && (regJourney.data.entries || []).some((e) => e.type === "call_logged"),
      "journey: stream intact"
    );
    const dashFinal = await api("GET", "/enquiry/dashboard", { token: internToken });
    ok(
      dashFinal.status === 200 &&
        Array.isArray(dashFinal.data.todaysMission) &&
        dashFinal.data.counts !== undefined,
      "dashboard refresh: payload shape intact (own scope)"
    );
    const enquiryList = await api("GET", "/enquiry?page=1&limit=20", { token: founderToken });
    ok(enquiryList.status === 200, "lead list loads");
  } catch (e) {
    failed++;
    failures.push(`FATAL: ${e.message}`);
    console.error("FATAL:", e);
    console.error(serverLog.split("\n").slice(-25).join("\n"));
  } finally {
    // ── Cleanup: every fixture this suite created ───────────────────────────
    section("Cleanup");
    try {
      child.kill();
      await new Promise((r) => mockServer.close(r));
      const leadIds = (await Enquiry.find({ phone: { $regex: `^${PHONE_PREFIX}` } }, { _id: 1 }).lean()).map((l) => l._id);
      const userIds = (await User.find({ phone: { $regex: `^${PHONE_PREFIX}` } }, { _id: 1 }).lean()).map((u) => u._id);
      await Promise.all([
        Event.deleteMany({ user: { $in: userIds } }),
        User.deleteMany({ phone: { $regex: `^${PHONE_PREFIX}` } }),
        LeadInternalEvent.deleteMany({ leadId: { $in: leadIds } }),
        ActivityLog.deleteMany({ entityType: "lead", entityId: { $in: leadIds.map(String) } }),
        WAAgentMessage.deleteMany({ phone: { $regex: `^${PHONE_PREFIX}` } }),
        WAConversation.deleteMany({ phone: { $regex: `^${PHONE_PREFIX}` } }),
        QualifiedLead.deleteMany({ phone: { $regex: `^${PHONE_PREFIX}` } }),
        VendorContact.deleteMany({ phone: { $regex: `^${PHONE_PREFIX}` } }),
        NotificationFailureLog.deleteMany({
          createdAt: { $gte: startedAt },
          service: { $in: ["Anthropic", "GoogleSheets", "KiaraCrmSync", "WhatsApp", "QualifiedLeadDB"] },
        }),
        Enquiry.deleteMany({ phone: { $regex: `^${PHONE_PREFIX}` } }),
        Admin.deleteMany({ _id: { $in: [founder._id, intern._id] } }),
        Role.deleteMany({ _id: { $in: [founderRole._id, internRole._id] } }),
        require("../models/Department").deleteMany({ _id: dept._id }),
      ]);
      // Restore settings exactly as found.
      await Setting.deleteMany({ key: { $in: touchedKeys } });
      for (const s of settingsBefore) {
        await Setting.create({ key: s.key, value: s.value, updatedBy: s.updatedBy || null });
      }
      const leftovers = await Promise.all([
        Enquiry.countDocuments({ phone: { $regex: `^${PHONE_PREFIX}` } }),
        WAConversation.countDocuments({ phone: { $regex: `^${PHONE_PREFIX}` } }),
        WAAgentMessage.countDocuments({ phone: { $regex: `^${PHONE_PREFIX}` } }),
        Admin.countDocuments({ name: /Kiara E2E/ }),
      ]);
      console.log(`  cleanup leftovers (should be all 0): ${leftovers.join(", ")}`);
    } catch (e) {
      console.error("  cleanup error:", e.message);
    }
    await mongoose.disconnect();
  }

  console.log(`\n══ RESULT: ${passed} passed, ${failed} failed ══`);
  if (failures.length) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed ? 1 : 0);
})();
