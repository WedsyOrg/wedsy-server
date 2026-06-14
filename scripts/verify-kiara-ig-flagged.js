/* ⚠️ REVIEW-REQUIRED features verification (Phase 2 flagged). In-process,
 * mocked Anthropic + IG Graph; NO live API. Port 8162 (mock).
 * A) Deterministic IG phone capture → lead created even when the AI extractor
 *    returns NO phone.
 * B) Conversation→facts Haiku extraction: runs at handoff, writes adFormAnswers,
 *    once-only, uses claude-haiku-4-5. */
require("dotenv").config();
const http = require("http");
const mongoose = require("mongoose");

const MOCK_PORT = 8162;
process.env.ANTHROPIC_API_URL = `http://localhost:${MOCK_PORT}/v1/messages`;
process.env.INSTAGRAM_GRAPH_BASE_URL = `http://localhost:${MOCK_PORT}`;
process.env.INSTAGRAM_AGENT_PAGE_ACCESS_TOKEN = "test-token";

let pass = 0, fail = 0; const failures = [];
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; failures.push(l); console.error(`  ✗ ${l}`); } };
const anthropicModels = [];
const factsCalls = []; // facts-extractor calls specifically (Haiku is also used by the summary)

const mock = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const json = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.method === "POST" && req.url === "/v1/messages") {
      const p = (() => { try { return JSON.parse(body); } catch { return {}; } })();
      anthropicModels.push(p.model);
      const sys = String(p.system || "");
      const transcript = (p.messages || []).map((m) => (typeof m.content === "string" ? m.content : "")).join(" ");
      if (sys.includes("mine a chat transcript")) {
        // Facts extractor (Haiku).
        factsCalls.push(p.model);
        return json({ content: [{ type: "text", text: JSON.stringify({
          eventType: "Wedding", city: "Bengaluru", eventDate: "December 2026", numberOfEvents: "2",
          venueStatus: "looking", venueName: "", servicesRequired: "decor, catering", budget: "15 lakh",
          weddingStyle: "South Indian", guests: "400", summary: "Bengaluru Dec wedding, decor+catering, ~15L.",
        }) }] });
      }
      if (sys.includes("data extractor")) {
        const m = transcript.match(/([6-9]\d{9})/);
        // NOAIPHONE sentinel: pretend the AI failed to capture the phone.
        const phone = /NOAIPHONE/.test(transcript) ? "" : (m ? m[1] : "");
        return json({ content: [{ type: "text", text: JSON.stringify({
          qualified: true, escalate: true, escalateReason: "Qualified", classification: "lead",
          data: { name: "Flagged Test", phoneNumber: phone, eventType: "Wedding", city: "Bengaluru" },
        }) }] });
      }
      return json({ content: [{ type: "text", text: "Got it!" }] });
    }
    if (req.method === "POST" && req.url === "/me/messages") return json({ message_id: "ig_mock" });
    if (req.method === "GET") return json({ name: "Flagged IG", username: "flagged.ig" });
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
  const QualifiedLead = require("../models/QualifiedLead");
  const IG = require("../services/InstagramAgentService");
  const FactExtraction = require("../services/KiaraFactExtractionService");

  const PHONE_A = "9911223344";
  const IGA = "IGSID_DETERM_" + Date.now();
  const IGB = "IGSID_FACTS_" + Date.now();
  const cleanup = async () => {
    const leads = await Enquiry.find({ phone: { $in: [`91${PHONE_A}`] } }, { _id: 1 }).lean();
    await LeadInternalEvent.deleteMany({ leadId: { $in: leads.map((l) => l._id) } });
    await Enquiry.deleteMany({ phone: { $in: [`91${PHONE_A}`] } });
    await WAConversation.deleteMany({ phone: { $in: [IGA, IGB] } });
    await WAAgentMessage.deleteMany({ phone: { $in: [IGA, IGB] } });
    await QualifiedLead.deleteMany({ phone: { $in: [IGA, IGB] } });
  };

  try {
    await cleanup();

    console.log("\n── A) Deterministic phone capture (AI returns NO phone) ──");
    await IG.receiveMessage(IGA, "hi NOAIPHONE planning a wedding");
    await IG.receiveMessage(IGA, "Bengaluru NOAIPHONE in December");
    await IG.receiveMessage(IGA, `NOAIPHONE call me on ${PHONE_A}`);
    const leadA = await Enquiry.findOne({ phone: `91${PHONE_A}` }).lean();
    ok(!!leadA, "lead created from the raw message phone even though the AI extractor returned no phoneNumber");

    console.log("\n── B) Conversation→facts extraction (Haiku, once, adFormAnswers) ──");
    // The IGA convo escalated at qualification → extraction should have run at handoff.
    const afterHandoff = await Enquiry.findById(leadA._id).lean();
    const af = (afterHandoff.additionalInfo && afterHandoff.additionalInfo.adFormAnswers) || {};
    ok(af.city === "Bengaluru" && af.servicesRequired === "decor, catering" && af.weddingStyle === "South Indian",
      "facts mined into additionalInfo.adFormAnswers at handoff");
    ok(!!(afterHandoff.additionalInfo && afterHandoff.additionalInfo.factsExtractedAt), "factsExtractedAt guard stamped");
    ok(factsCalls.every((m) => m === "claude-haiku-4-5") && factsCalls.length >= 1, "extraction used the Haiku model (claude-haiku-4-5)");

    // Once-only: a direct re-trigger must be a no-op (returns null, no new call).
    const factsBefore = factsCalls.length;
    const second = await FactExtraction.extractFactsForLead(leadA._id, IGA);
    ok(second === null && factsCalls.length === factsBefore, "extraction is once-per-lead (re-trigger is a no-op, no extra call)");

    // Per-message safety: the facts extractor ran EXACTLY ONCE for the whole
    // conversation (at handoff), never per message. (The other Haiku call seen
    // is the separate Kiara summary, which also uses claude-haiku-4-5.)
    ok(factsCalls.length === 1, `exactly one facts-extraction call for the lead (got ${factsCalls.length}) — not per message`);
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
