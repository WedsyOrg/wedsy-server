/**
 * MEGA BUILD item 1 (+2) — Kiara extractor hardening + user_signup_greet Meta leg.
 *
 *   node tests/kiara-extractor-hardening.test.js
 *
 * In-process HTTP mock rides the existing env seams (ANTHROPIC_API_URL,
 * META_GRAPH_BASE_URL, INSTAGRAM_GRAPH_BASE_URL — same idiom as scripts/e2e-kiara).
 * Covers:
 *   • extractor requests END with the closing user turn (the prefill fix)
 *   • truncated JSON output repaired by parseModelJson step 4
 *   • empty-content: retried ONCE (2 attempts, not 3), then extractorFailed
 *   • WA final failure → needsHumanQualification flag + AdminNotification
 *   • IG final failure → AdminNotification with the handle, NO lead created
 *   • user_signup_greet → Meta Cloud API template payload (1 body param);
 *     empty-variables template sends NO components (the 400 #132000 fix)
 */
require("dotenv").config();
const http = require("http");
const crypto = require("crypto");

// Env seams MUST be set before the modules under test are required (they read
// these at module load).
let MOCK_PORT = 0;
const mock = {
  anthropicCalls: [],
  extractorMode: "valid", // valid | truncated | empty
  metaCalls: [],
  igCalls: [],
};

const VALID_EXTRACTION = {
  qualified: false, escalate: false, escalateReason: "", classification: "lead",
  data: { name: "Mock Couple", eventType: "wedding", city: "Bengaluru", eventDate: "", numberOfEvents: "", venueStatus: "", venueName: "", servicesRequired: "", budget: "", weddingStyle: "" },
};
// Valid object cut mid-"data" — only step-4 repair can save this.
const TRUNCATED_TEXT = JSON.stringify(VALID_EXTRACTION).slice(0, 120);

const mockServer = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    if (req.url === "/v1/messages") {
      const isExtractor = String(body.system || "").startsWith("You are a data extractor");
      mock.anthropicCalls.push({ isExtractor, messages: body.messages, max_tokens: body.max_tokens });
      let content;
      if (isExtractor) {
        if (mock.extractorMode === "empty") content = [];
        else if (mock.extractorMode === "truncated") content = [{ type: "text", text: TRUNCATED_TEXT }];
        else content = [{ type: "text", text: JSON.stringify(VALID_EXTRACTION) }];
      } else {
        content = [{ type: "text", text: "Lovely! Tell me more about your big day ✨" }];
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "msg_mock", content, stop_reason: "end_turn" }));
      return;
    }
    if (/\/messages$/.test(req.url)) {
      // Meta WA Cloud API (any phone-number id) + IG /me/messages.
      (req.url.includes("/me/messages") ? mock.igCalls : mock.metaCalls).push({ url: req.url, body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: "wamid.mock" }] }));
      return;
    }
    // IG profile fetch: GET /<igsid>?fields=name,username
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ name: "megatest-handle", username: "megatest-handle" }));
  });
});

const TAG = `kiarahard-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => mockServer.listen(0, r));
  MOCK_PORT = mockServer.address().port;
  process.env.ANTHROPIC_API_URL = `http://127.0.0.1:${MOCK_PORT}/v1/messages`;
  process.env.META_GRAPH_BASE_URL = `http://127.0.0.1:${MOCK_PORT}/graph`;
  process.env.INSTAGRAM_GRAPH_BASE_URL = `http://127.0.0.1:${MOCK_PORT}/ig`;

  // Requires AFTER the seams are set.
  const mongoose = require("mongoose");
  const Enquiry = require("../models/Enquiry");
  const WAConversation = require("../models/WAConversation");
  const WAAgentMessage = require("../models/WAAgentMessage");
  const AdminNotification = require("../models/AdminNotification");
  const NotificationFailureLog = require("../models/NotificationFailureLog");
  const parseModelJson = require("../utils/parseModelJson");
  const WhatsAppAgentService = require("../services/WhatsAppAgentService");
  const InstagramAgentService = require("../services/InstagramAgentService");
  const NotificationService = require("../services/NotificationService");

  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  const startedAt = new Date();
  // Distinct 10-digit tails: LeadIntake dedups by "phone ENDS WITH the
  // normalized digits", so two test phones must never share a suffix.
  const base = String(Date.now()).slice(-8);
  const PHONE_A = `+9111${base}`;
  const PHONE_B = `+9122${base.split("").reverse().join("")}`;
  const IG_ID = `${TAG}-igsid`;

  try {
    // ── 0. parseModelJson truncation repair (unit) ───────────────────────────
    const repaired = parseModelJson(TRUNCATED_TEXT);
    ok(repaired && repaired.qualified === false && typeof repaired.data === "object",
      "parseModelJson repairs truncated (max_tokens-cut) JSON");
    ok(parseModelJson('```json\n{"a":1}\n```').a === 1, "fence parse still works");
    ok(parseModelJson("Sure! Here you go: {\"a\":2} hope that helps").a === 2, "prose-wrapped parse still works");
    ok(parseModelJson("no json here at all") === null, "genuinely unparseable still null");

    // ── 1. WA: extractor payload + truncated repair end-to-end ──────────────
    mock.extractorMode = "truncated";
    await WhatsAppAgentService.receiveMessage(PHONE_A, "hi, planning a wedding");
    await WhatsAppAgentService.receiveMessage(PHONE_A, "in bengaluru this december");
    mock.anthropicCalls.length = 0;
    await WhatsAppAgentService.receiveMessage(PHONE_A, "budget around 8 lakhs");
    const extractorCallsA = mock.anthropicCalls.filter((c) => c.isExtractor);
    ok(extractorCallsA.length === 1, `truncated-but-repairable → exactly ONE extractor call (got ${extractorCallsA.length})`);
    const lastMsg = extractorCallsA[0] && extractorCallsA[0].messages[extractorCallsA[0].messages.length - 1];
    ok(lastMsg && lastMsg.role === "user" && /Extract now/.test(String(lastMsg.content)),
      "extractor history ENDS with the closing user turn (prefill fix)");
    ok(extractorCallsA[0].max_tokens === 800, "extractor max_tokens raised to 800 (truncation headroom)");
    const leadA = await Enquiry.findOne({ phone: PHONE_A }).lean();
    ok(leadA && !leadA.needsHumanQualification, "repairable output → lead NOT flagged for human qualification");

    // ── 2. WA: persistent empty content → retry once, flag + notify ─────────
    mock.extractorMode = "empty";
    await WhatsAppAgentService.receiveMessage(PHONE_B, "hello there");
    await WhatsAppAgentService.receiveMessage(PHONE_B, "wedding enquiry");
    mock.anthropicCalls.length = 0;
    await WhatsAppAgentService.receiveMessage(PHONE_B, "next may, in mysore");
    const extractorCallsB = mock.anthropicCalls.filter((c) => c.isExtractor);
    ok(extractorCallsB.length === 2, `empty content retried ONCE — 2 attempts, not 3 (got ${extractorCallsB.length})`);
    const leadB = await Enquiry.findOne({ phone: PHONE_B }).lean();
    ok(leadB && leadB.needsHumanQualification === true,
      "terminal extractor failure → needsHumanQualification flag set on the lead");
    const notifB = await AdminNotification.find({ type: "needs_human_qualification", leadId: leadB._id }).lean();
    ok(notifB.length >= 1 && /Kiara couldn't qualify .* — review manually/.test(notifB[0].title),
      `owner/triage notified ("${notifB[0] && notifB[0].title}")`);
    ok(await NotificationFailureLog.exists({ service: "Anthropic", error: /no text block/, createdAt: { $gte: startedAt } }),
      "FailureLog row kept for the terminal failure");

    // ── 3. IG: persistent empty → notify with handle, NO lead created ────────
    mock.extractorMode = "empty";
    await InstagramAgentService.receiveMessage(IG_ID, "hey, do you plan weddings?");
    await InstagramAgentService.receiveMessage(IG_ID, "mine is next year");
    mock.anthropicCalls.length = 0;
    await InstagramAgentService.receiveMessage(IG_ID, "we are two hundred guests");
    const extractorCallsC = mock.anthropicCalls.filter((c) => c.isExtractor);
    ok(extractorCallsC.length === 2, `IG empty content also retried once (got ${extractorCallsC.length})`);
    const igNotif = await AdminNotification.find({
      type: "needs_human_qualification",
      title: { $regex: "megatest-handle" },
    }).lean();
    ok(igNotif.length >= 1, "IG failure → AdminNotification carries the IG handle");
    ok(!(await Enquiry.exists({ phone: `ig:${IG_ID}` })),
      "NO lead auto-created for the unclassified IG DM");

    // ── 4. user_signup_greet via Meta Cloud API ───────────────────────────────
    mock.metaCalls.length = 0;
    NotificationService.send("user_signup_greet", { phone: "+911234567890", name: "Asha", variables: ["Asha"] });
    await sleep(400); // fire-and-forget settles
    const greet = mock.metaCalls.find((c) => c.body?.template?.name === "user_signup_greet");
    ok(!!greet, "user_signup_greet now sends via the Meta Cloud API (not AiSensy)");
    ok(greet && greet.body.template.components.length === 1 &&
       greet.body.template.components[0].type === "body" &&
       greet.body.template.components[0].parameters[0].text === "Asha",
      "payload: ONE body component with the name variable (Meta contract)");

    // Empty-variables template: components must be OMITTED (the #132000 fix).
    const { sendWhatsApp } = require("../utils/whatsapp");
    mock.metaCalls.length = 0;
    await sendWhatsApp("+911234567890", "no_variable_template", []);
    const noVar = mock.metaCalls[0];
    ok(noVar && Array.isArray(noVar.body.template.components) && noVar.body.template.components.length === 0,
      "zero-variable template sends an EMPTY components array (no bogus body component)");

    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    const mongoose = require("mongoose");
    const Enquiry = require("../models/Enquiry");
    const WAConversation = require("../models/WAConversation");
    const WAAgentMessage = require("../models/WAAgentMessage");
    const AdminNotification = require("../models/AdminNotification");
    const NotificationFailureLog = require("../models/NotificationFailureLog");
    const phones = [PHONE_A, PHONE_B, IG_ID, `ig:${IG_ID}`];
    const leads = await Enquiry.find({ phone: { $in: phones } }, { _id: 1 }).lean().catch(() => []);
    await AdminNotification.deleteMany({
      $or: [{ leadId: { $in: leads.map((l) => l._id) } }, { title: { $regex: "megatest-handle" } }],
    }).catch(() => {});
    await NotificationFailureLog.deleteMany({ createdAt: { $gte: startedAt }, service: { $in: ["Anthropic", "WhatsApp"] } }).catch(() => {});
    await WAAgentMessage.deleteMany({ phone: { $in: phones } }).catch(() => {});
    await WAConversation.deleteMany({ phone: { $in: phones } }).catch(() => {});
    await Enquiry.deleteMany({ phone: { $in: phones } }).catch(() => {});
    await mongoose.disconnect().catch(() => {});
    mockServer.close();
    process.exit(fail ? 1 : 0);
  }
})();
