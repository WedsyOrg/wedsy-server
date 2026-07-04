/* Kiara IG fixes — SAFE tier verification (in-process, mocked Anthropic + IG
 * Graph; NO live API, NO server spawn). Port 8161 (mock).
 * Covers: IG inbound with a phone → lead created identically to intake (dedup
 * respected), IG name resolved via Graph profile fetch, swallowed parse error
 * surfaced to NotificationFailureLog. */
require("dotenv").config();
const http = require("http");
const mongoose = require("mongoose");

const MOCK_PORT = 8161;
process.env.ANTHROPIC_API_URL = `http://localhost:${MOCK_PORT}/v1/messages`;
process.env.INSTAGRAM_GRAPH_BASE_URL = `http://localhost:${MOCK_PORT}`;
process.env.INSTAGRAM_AGENT_PAGE_ACCESS_TOKEN = "test-token";

let pass = 0, fail = 0; const failures = [];
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; failures.push(l); console.error(`  ✗ ${l}`); } };

// One mock for all three seams: Anthropic messages, IG send, IG profile.
const mock = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const json = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.method === "POST" && req.url === "/v1/messages") {
      const payload = (() => { try { return JSON.parse(body); } catch { return {}; } })();
      const isExtractor = String(payload.system || "").includes("data extractor");
      const transcript = (payload.messages || []).map((m) => (typeof m.content === "string" ? m.content : "")).join(" ");
      if (!isExtractor) return json({ content: [{ type: "text", text: "Got it! 😊" }] });
      if (/BADJSON/.test(transcript)) return json({ content: [{ type: "text", text: "this is not json {{{" }] });
      const m = transcript.match(/([6-9]\d{9})/);
      const phone = m ? m[1] : "";
      return json({ content: [{ type: "text", text: JSON.stringify({
        qualified: true, escalate: true, escalateReason: "Qualified — ready for your call",
        classification: "lead",
        data: { name: "Priya Extractor", phoneNumber: phone, eventType: "Wedding", city: "Bengaluru" },
      }) }] });
    }
    if (req.method === "POST" && req.url === "/me/messages") return json({ message_id: "ig_mock" });
    // IG profile fetch: GET /{igsid}?fields=name,username
    if (req.method === "GET") return json({ name: "Priya IG", username: "priya.ig" });
    res.writeHead(404); res.end();
  });
});

(async () => {
  await mongoose.connect(process.env.DATABASE_URL);
  await new Promise((r) => mock.listen(MOCK_PORT, r));
  const Enquiry = require("../models/Enquiry");
  const WAConversation = require("../models/WAConversation");
  const WAAgentMessage = require("../models/WAAgentMessage");
  const LeadInternalEvent = require("../models/LeadInternalEvent");
  const NotificationFailureLog = require("../models/NotificationFailureLog");
  const QualifiedLead = require("../models/QualifiedLead");
  const IG = require("../services/InstagramAgentService");

  const PHONE = "9988776655";
  const IG1 = "IGSID_AAA_" + Date.now();
  const IG2 = "IGSID_BBB_" + Date.now();
  const IG3 = "IGSID_BADJSON_" + Date.now();
  const cleanup = async () => {
    await Enquiry.deleteMany({ phone: { $in: [`91${PHONE}`, PHONE] } });
    await WAConversation.deleteMany({ phone: { $in: [IG1, IG2, IG3] } });
    await WAAgentMessage.deleteMany({ phone: { $in: [IG1, IG2, IG3] } });
    await QualifiedLead.deleteMany({ phone: { $in: [IG1, IG2, IG3] } });
    const leads = await Enquiry.find({ phone: `91${PHONE}` }, { _id: 1 }).lean();
    await LeadInternalEvent.deleteMany({ leadId: { $in: leads.map((l) => l._id) } });
    await NotificationFailureLog.deleteMany({ service: { $in: ["IgExtractorParse", "IgLeadLink"] }, createdAt: { $gte: new Date(Date.now() - 600000) } });
  };

  try {
    await cleanup();

    console.log("\n── IG inbound with a phone → lead created (mirrors intake) ──");
    // 3 user messages (the <3 early-skip means qualification runs on the 3rd).
    await IG.receiveMessage(IG1, "hi, planning my wedding");
    await IG.receiveMessage(IG1, "in Bengaluru, December");
    await IG.receiveMessage(IG1, `my number is ${PHONE}`);
    const lead1 = await Enquiry.findOne({ phone: `91${PHONE}` }).lean();
    ok(!!lead1, "a CRM lead was created from the IG conversation");
    ok(lead1 && lead1.source === "instagram", "lead source is instagram");
    ok(lead1 && lead1.additionalInfo && lead1.additionalInfo.instagramId === IG1, "lead carries the instagramId");
    const conv1 = await WAConversation.findOne({ phone: IG1 }).lean();
    ok(conv1 && String(conv1.enquiryId) === String(lead1._id), "the IG conversation is linked to the lead");
    ok((await LeadInternalEvent.countDocuments({ leadId: lead1._id, type: "ig_conversation_linked" })) >= 1, "ig_conversation_linked journey event recorded");

    console.log("\n── IG name resolved via Graph profile fetch ──");
    ok(conv1 && conv1.profileName === "Priya IG", `conversation.profileName resolved from Graph (got: ${conv1 && conv1.profileName})`);

    console.log("\n── Dedup: a second IG thread, same phone → no duplicate lead ──");
    await IG.receiveMessage(IG2, "hello");
    await IG.receiveMessage(IG2, "wedding in Bengaluru");
    await IG.receiveMessage(IG2, `reach me on ${PHONE}`);
    const count = await Enquiry.countDocuments({ phone: `91${PHONE}` });
    ok(count === 1, `exactly one lead for the shared phone (got ${count})`);
    ok((await LeadInternalEvent.countDocuments({ leadId: lead1._id, type: "re_enquired" })) >= 1, "re_enquiry recorded on the existing lead");

    console.log("\n── Swallowed extractor parse error now surfaced ──");
    await IG.receiveMessage(IG3, "hi BADJSON");
    await IG.receiveMessage(IG3, "wedding BADJSON");
    await IG.receiveMessage(IG3, "more BADJSON details");
    const parseLog = await NotificationFailureLog.findOne({ service: "IgExtractorParse" }).sort({ createdAt: -1 }).lean();
    ok(!!parseLog, "a malformed extractor JSON is logged to NotificationFailureLog (no longer silent)");
  } catch (e) {
    fail++; failures.push(`fatal: ${e.message}`); console.error("FATAL", e);
  } finally {
    await cleanup();
    mock.close(); await mongoose.disconnect();
    console.log(`\n══ RESULT: ${pass} passed, ${fail} failed ══`);
    if (failures.length) console.log("failures:", failures.join(" | "));
    process.exit(fail === 0 ? 0 : 1);
  }
})();
