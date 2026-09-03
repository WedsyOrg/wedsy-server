/**
 * INSTAGRAM HUMAN AGENT TAG — the 7-day window, and the wall between the
 * automated and human send paths.
 *
 * Meta's HUMAN_AGENT tag lets a PERSON reply to a customer-initiated Instagram
 * thread for 7 days, past the normal 24-hour window. Two things must be true at
 * once, and the second is the one that would end the app:
 *
 *   • a human CAN answer a thread that went quiet overnight, and
 *   • an automated reply can NEVER carry the tag, because that is a policy
 *     violation on the app Instagram messaging, OAuth and app review all
 *     depend on.
 *
 * PURE — the network, models and repositories are stubbed. Every case drives
 * the real utils/instagram.js and WAConversationService.sendText.
 *
 *   node tests/ig-human-agent-tag.test.js
 */
process.env.INSTAGRAM_AGENT_PAGE_ACCESS_TOKEN = "test-token";

const Module = require("module");

let sentBodies = [];
const conversations = {};
const origLoad = Module._load;
Module._load = function (request) {
  if (request.endsWith("/ConnectedInstagramAccount")) return { findOne: () => ({ sort: () => ({ lean: async () => null }) }) };
  if (request.endsWith("/NotificationFailureLog")) return { create: async () => ({}) };
  if (request.endsWith("/repositories/WAConversationRepository")) return WAConvRepoStub;
  if (request.endsWith("/repositories/EnquiryRepository")) return { stampFirstRespondedAt: async () => {}, touchLastActivity: async () => {} };
  if (request.endsWith("/services/LeadInternalEventService") || request.endsWith("/LeadInternalEventService")) return { record: async () => {} };
  if (request.endsWith("/models/WAAgentMessage")) return WAAgentMessageStub;
  if (request.endsWith("/models/Enquiry")) return { findOne: () => ({ lean: async () => ({ _id: "lead1" }) }) };
  if (request.endsWith("/utils/whatsapp")) return { sendWhatsAppText: async () => { sentBodies.push({ channel: "whatsapp" }); return { ok: true }; } };
  return origLoad.apply(this, arguments);
};
const WAConvRepoStub = {
  findById: async (id) => conversations[id] || null,
  touchOutbound: async (id) => ({ toObject: () => ({ ...conversations[id] }) }),
  updateFieldsById: async (id, f) => { Object.assign(conversations[id], f); return { toObject: () => ({ ...conversations[id] }) }; },
};
function WAAgentMessageStub(doc) { this.doc = doc; }
WAAgentMessageStub.prototype.save = async function () { return { ...this.doc, populate: async () => {} }; };

global.fetch = async (url, opts) => {
  sentBodies.push({ url: String(url), body: JSON.parse(opts.body) });
  return { ok: true, status: 200, json: async () => ({ message_id: "m1" }), text: async () => "{}" };
};

const ig = require("../utils/instagram");
const svc = require("../services/WAConversationService");

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.error(`  ✗ ${l}`); } };
const eq = (g, w, l) => ok(g === w, `${l} (got ${JSON.stringify(g)})`);
const hoursAgo = (h) => new Date(Date.now() - h * 3600e3);
// getScoped() runs assertValidId first, so fixtures need real ObjectId shapes.
let idSeq = 0;
const OID = {};
const oid = (name) => (OID[name] = OID[name] || (++idSeq).toString().padStart(24, "a"));
const mkConv = (name, over) => {
  const id = oid(name);
  conversations[id] = {
    _id: id, phone: "ig_user_1", channel: "instagram", mode: "human",
    lastInboundAt: hoursAgo(1), enquiryId: "lead1", ...over,
  };
  return id;
};
const send = async (name, text = "hello") => {
  try { return { ok: true, res: await svc.sendText(oid(name), text, "admin1", {}) }; }
  catch (e) { return { ok: false, status: e.status, message: e.message, err: e }; }
};

const run = async () => {

console.log("\n1. THE WALL — an automated reply can never carry the tag");
{
  sentBodies = [];
  await ig.sendInstagramDM("ig_user_1", "Kiara's automated reply");
  const body = sentBodies[0].body;
  eq(body.tag, undefined, "sendInstagramDM sends NO tag");
  eq(body.messaging_type, undefined, "sendInstagramDM sends NO messaging_type");
  eq(JSON.stringify(Object.keys(body).sort()), '["message","recipient"]', "…exactly recipient + message, nothing else");

  sentBodies = [];
  await ig.sendInstagramHumanAgentDM("ig_user_1", "a human typed this");
  const hb = sentBodies[0].body;
  eq(hb.messaging_type, "MESSAGE_TAG", "human-agent send sets messaging_type");
  eq(hb.tag, "HUMAN_AGENT", "human-agent send sets tag HUMAN_AGENT");

  // The API shape is the guarantee: there is no way to ask for a tag.
  eq(ig.sendInstagramDM.length, 2, "sendInstagramDM takes (recipientId, message) — no options object to smuggle a tag through");
  eq(typeof ig.postInstagramMessage, "undefined", "the shared transport is NOT exported (no third way to send)");
}
{
  // KIARA'S ACTUAL PATH. Not a claim about the code — the real module is loaded
  // and its send call inspected.
  const src = require("fs").readFileSync(require.resolve("../services/InstagramAgentService"), "utf8");
  ok(/sendInstagramDM/.test(src), "InstagramAgentService references sendInstagramDM");
  ok(!/sendInstagramHumanAgentDM/.test(src),
    "InstagramAgentService NEVER references the human-agent function (Kiara cannot tag)");
  const other = require("child_process")
    .execSync("grep -rl 'sendInstagramHumanAgentDM' services/ controllers/ utils/ 2>/dev/null || true", { encoding: "utf8" })
    .split("\n").filter(Boolean).sort();
  eq(JSON.stringify(other), '["services/WAConversationService.js","utils/instagram.js"]',
    "the ONLY caller of the human-agent function is WAConversationService (+ its definition)");
}

console.log("\n2. WHATSAPP IS UNCHANGED");
{
  mkConv("wa1", { channel: "whatsapp", lastInboundAt: hoursAgo(30) });
  const r = await send("wa1");
  eq(r.ok, false, "WhatsApp past 24h is refused");
  eq(r.status, 422, "…with 422");
  eq(r.err.windowClosed, true, "…and windowClosed: true (the re-engage template contract)");
  ok(/re-engage template/.test(r.message), "…and the template message, unchanged");
  eq(r.err.humanAgentWindowClosed, undefined, "…and NO human-agent flag on a WhatsApp error");
}
{
  sentBodies = [];
  mkConv("wa2", { channel: "whatsapp", lastInboundAt: hoursAgo(2) });
  const r = await send("wa2");
  eq(r.ok, true, "WhatsApp inside 24h still sends");
  eq(sentBodies[0].channel, "whatsapp", "…via the WhatsApp transport");
}

console.log("\n3. INSTAGRAM — inside 24h, inside 7 days, past 7 days");
{
  sentBodies = [];
  mkConv("ig1", { lastInboundAt: hoursAgo(2) });
  const r = await send("ig1");
  eq(r.ok, true, "IG inside 24h sends");
  eq(sentBodies[0].body.tag, undefined, "…WITHOUT the tag (it is not needed, so it is not claimed)");
}
{
  sentBodies = [];
  mkConv("ig2", { lastInboundAt: hoursAgo(30) });
  const r = await send("ig2");
  eq(r.ok, true, "IG past 24h but inside 7 days SENDS — the gap this closes");
  eq(sentBodies[0].body.messaging_type, "MESSAGE_TAG", "…with messaging_type MESSAGE_TAG");
  eq(sentBodies[0].body.tag, "HUMAN_AGENT", "…and tag HUMAN_AGENT");
}
{
  sentBodies = [];
  mkConv("ig3", { lastInboundAt: hoursAgo(24 * 7 - 2) });
  const r = await send("ig3");
  eq(r.ok, true, "IG at 6d22h — just inside — still sends");
}
{
  sentBodies = [];
  mkConv("ig4", { lastInboundAt: hoursAgo(24 * 7 + 1) });
  const r = await send("ig4");
  eq(r.ok, false, "IG past 7 days is REFUSED");
  eq(r.status, 422, "…with 422");
  eq(r.err.humanAgentWindowClosed, true, "…flagged humanAgentWindowClosed, NOT windowClosed");
  eq(r.err.windowClosed, undefined, "…so a client cannot mistake it for 'send a template'");
  ok(/7 days/.test(r.message), "…message names the 7-day rule");
  ok(/no longer be replied to/.test(r.message), "…and says plainly that the thread is over");
  ok(!/re-engage template/.test(r.message), "…and does NOT offer a template that does not exist on Instagram");
  eq(sentBodies.length, 0, "…and nothing was sent to Meta");
}

console.log("\n4. THE 409 GATE STILL FIRES (what makes the tag true by construction)");
{
  sentBodies = [];
  mkConv("ig5", { mode: "ai", lastInboundAt: hoursAgo(30) });
  const r = await send("ig5");
  eq(r.ok, false, "a conversation still in AI mode is refused");
  eq(r.status, 409, "…with 409, before any window logic");
  ok(/take over before sending/.test(r.message), "…telling the human to take over first");
  eq(sentBodies.length, 0, "…and NOTHING is sent — so the tag can never be claimed for an untaken thread");
}

console.log("\n5. THE COUNTDOWN PAYLOAD (API side; T1 renders it)");
{
  const w = (ch, h) => svc.windowInfo({ channel: ch, lastInboundAt: hoursAgo(h) });
  eq(w("instagram", 2).sendWindow.urgency, "open", "IG 2h → open");
  eq(w("instagram", 24 * 5).sendWindow.urgency, "open", "IG 5d → open");
  eq(w("instagram", 24 * 5 + 6).sendWindow.urgency, "warning", "IG 5d6h (<2d left) → warning");
  eq(w("instagram", 24 * 6 + 6).sendWindow.urgency, "critical", "IG 6d6h (<1d left) → critical");
  eq(w("instagram", 24 * 8).sendWindow.urgency, "expired", "IG 8d → expired");
  eq(w("instagram", 24 * 8).sendWindow.canSendNow, false, "…and canSendNow false");

  // WhatsApp stays deliberately quiet — a closed window there is recoverable.
  eq(w("whatsapp", 2).sendWindow.urgency, "open", "WA 2h → open");
  eq(w("whatsapp", 30).sendWindow.urgency, "template_required", "WA 30h → template_required, NOT an alarm");
  ok(!["critical", "warning", "expired"].includes(w("whatsapp", 24 * 9).sendWindow.urgency),
    "WhatsApp NEVER escalates to critical/expired — the consequences differ");

  // The clock must be the customer's last message, not ours.
  const c = { channel: "instagram", lastInboundAt: hoursAgo(24 * 6), lastMessageAt: new Date() };
  const closes = svc.windowInfo(c).sendWindow.closesAt;
  const expected = new Date(hoursAgo(24 * 6).getTime() + svc.HUMAN_AGENT_WINDOW_MS);
  ok(Math.abs(closes - expected) < 1000, "countdown runs from lastInboundAt, NOT lastMessageAt (an outbound must not extend it)");

  const none = svc.windowInfo({ channel: "instagram", lastInboundAt: null });
  eq(none.sendWindow.urgency, "unknown", "no inbound yet → unknown, not a false deadline");
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
};

run().catch((e) => { console.error("suite crashed:", e); process.exit(1); });
