/* IG lead-creation gate — REVISED: wedding INTENT, not phone presence.
 * In-process, mocked Anthropic + IG Graph; NO live API. Port 8163 (mock).
 * Covers: intent+phone, intent+no-phone (flag), no-intent→no lead, same sender→
 * one lead, no-number→phone upgrade-in-place, upgrade→merge onto existing phone
 * lead, facts extraction at handoff (Haiku). */
require("dotenv").config();
const http = require("http");
const mongoose = require("mongoose");

const MOCK_PORT = 8163;
process.env.ANTHROPIC_API_URL = `http://localhost:${MOCK_PORT}/v1/messages`;
process.env.INSTAGRAM_GRAPH_BASE_URL = `http://localhost:${MOCK_PORT}`;
process.env.INSTAGRAM_AGENT_PAGE_ACCESS_TOKEN = "test-token";

let pass = 0, fail = 0; const failures = [];
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; failures.push(l); console.error(`  ✗ ${l}`); } };
const factsCalls = [];

// Mock: extractor (data extractor), facts (mine a chat transcript), reply, IG.
const mock = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const json = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.method === "POST" && req.url === "/v1/messages") {
      const p = (() => { try { return JSON.parse(body); } catch { return {}; } })();
      const sys = String(p.system || "");
      const t = (p.messages || []).map((m) => (typeof m.content === "string" ? m.content : "")).join(" ");
      if (sys.includes("mine a chat transcript")) {
        factsCalls.push(p.model);
        return json({ content: [{ type: "text", text: JSON.stringify({
          eventType: "Wedding", city: "Bengaluru", eventDate: "Dec 2026", numberOfEvents: "2",
          venueStatus: "looking", venueName: "", servicesRequired: "decor, catering", budget: "15L",
          weddingStyle: "South Indian", guests: "400", summary: "Bengaluru Dec wedding.",
        }) }] });
      }
      if (sys.includes("data extractor")) {
        const notWedding = /NOTWEDDING/.test(t);
        const m = t.match(/([6-9]\d{9})/);
        const phone = (/NOPHONE/.test(t) || !m) ? "" : m[1];
        return json({ content: [{ type: "text", text: JSON.stringify({
          qualified: !!phone, escalate: !!phone, escalateReason: phone ? "Qualified" : "",
          classification: notWedding ? "vendor" : "lead",
          data: { name: "IG Lead", phoneNumber: phone, eventType: "Wedding", city: "Bengaluru" },
        }) }] });
      }
      return json({ content: [{ type: "text", text: "Got it!" }] });
    }
    if (req.method === "POST" && req.url === "/me/messages") return json({ message_id: "ig_mock" });
    if (req.method === "GET") return json({ name: "Test IG", username: "test.ig" });
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
  const LeadIntakeService = require("../services/LeadIntakeService");
  const IG = require("../services/InstagramAgentService");

  const ts = String(Date.now()).slice(-8);
  const SENDER = {
    phone: `IGSID_PH_${ts}`, nophone: `IGSID_NP_${ts}`, junk: `IGSID_JUNK_${ts}`,
    upgrade: `IGSID_UP_${ts}`, merge: `IGSID_MG_${ts}`,
  };
  const P_PHONE = "9876500001";   // intent+phone scenario
  const P_UPGRADE = "9876500002"; // no-number → upgrade
  const P_MERGE = "9876500003";   // pre-existing phone lead → merge
  const allSenders = Object.values(SENDER);
  const allPhones = [`91${P_PHONE}`, `91${P_UPGRADE}`, `91${P_MERGE}`, ...allSenders.map((s) => `ig:${s}`)];

  const cleanup = async () => {
    const leads = await Enquiry.find({ $or: [{ phone: { $in: allPhones } }, { "additionalInfo.instagramId": { $in: allSenders } }] }, { _id: 1 }).lean();
    await LeadInternalEvent.deleteMany({ leadId: { $in: leads.map((l) => l._id) } });
    await Enquiry.deleteMany({ _id: { $in: leads.map((l) => l._id) } });
    await WAConversation.deleteMany({ phone: { $in: allSenders } });
    await WAAgentMessage.deleteMany({ phone: { $in: allSenders } });
    await QualifiedLead.deleteMany({ phone: { $in: allSenders } });
  };
  const conv = (s) => WAConversation.findOne({ phone: s }).lean();
  const igLead = (s) => Enquiry.findOne({ "additionalInfo.instagramId": s }).lean();

  try {
    await cleanup();

    console.log("\n── Intent + phone → lead with phone ──");
    await IG.receiveMessage(SENDER.phone, "hi planning my wedding");
    await IG.receiveMessage(SENDER.phone, "in Bengaluru, December");
    await IG.receiveMessage(SENDER.phone, `reach me on ${P_PHONE}`);
    const l1 = await Enquiry.findOne({ phone: `91${P_PHONE}` }).lean();
    ok(!!l1 && l1.source === "instagram", "wedding-intent + phone → lead created with the real phone");
    ok(l1 && (!l1.additionalInfo || !l1.additionalInfo.awaitingNumber), "phone lead is NOT flagged awaiting-number");

    console.log("\n── Facts extraction ran at handoff (Haiku) ──");
    const l1full = await Enquiry.findById(l1._id).lean();
    ok(l1full.additionalInfo && l1full.additionalInfo.adFormAnswers && l1full.additionalInfo.adFormAnswers.city === "Bengaluru", "transcript mined to adFormAnswers at handoff");
    ok(factsCalls.length === 1 && factsCalls[0] === "claude-haiku-4-5", "exactly one Haiku facts call");

    console.log("\n── Intent + NO phone → lead with profileName + flag ──");
    await IG.receiveMessage(SENDER.nophone, "hi NOPHONE wedding help");
    await IG.receiveMessage(SENDER.nophone, "Bengaluru NOPHONE");
    await IG.receiveMessage(SENDER.nophone, "NOPHONE planning a big wedding");
    const lnp = await igLead(SENDER.nophone);
    ok(!!lnp, "wedding-intent + NO phone → lead STILL created");
    ok(lnp && lnp.name === "Test IG", "no-number lead named from the IG profile");
    ok(lnp && lnp.phone === `ig:${SENDER.nophone}` && lnp.additionalInfo.awaitingNumber === true, "stored igSenderId placeholder + awaitingNumber flag");
    ok(lnp && lnp.stage === "new", "no-number lead is stage:new (enters normal pipeline + assignment)");
    const cnp = await conv(SENDER.nophone);
    ok(cnp && String(cnp.enquiryId) === String(lnp._id), "conversation linked to the no-number lead");

    console.log("\n── No wedding intent → NO lead ──");
    await IG.receiveMessage(SENDER.junk, "hi NOTWEDDING");
    await IG.receiveMessage(SENDER.junk, "NOTWEDDING just browsing");
    await IG.receiveMessage(SENDER.junk, "NOTWEDDING random");
    ok(!(await igLead(SENDER.junk)), "non-wedding DM creates NO lead");
    const cj = await conv(SENDER.junk);
    ok(cj && !cj.enquiryId, "junk conversation stays unlinked");

    console.log("\n── Same IG sender messaging again → ONE lead ──");
    await IG.receiveMessage(SENDER.nophone, "NOPHONE still here, any update?");
    await IG.receiveMessage(SENDER.nophone, "NOPHONE excited to plan");
    const dupCount = await Enquiry.countDocuments({ "additionalInfo.instagramId": SENDER.nophone });
    ok(dupCount === 1, `same sender → exactly one lead (got ${dupCount})`);

    console.log("\n── No-number lead later gives a phone → upgrade in place ──");
    await IG.receiveMessage(SENDER.nophone, `ok my number is ${P_UPGRADE}`);
    const upgraded = await igLead(SENDER.nophone);
    ok(upgraded && upgraded.phone === `91${P_UPGRADE}`, "existing lead upgraded with the real phone (no placeholder)");
    ok(upgraded && upgraded.additionalInfo.awaitingNumber === false, "awaiting-number flag cleared on upgrade");
    ok(String(upgraded._id) === String(lnp._id), "upgrade is in-place (same lead _id, no duplicate)");
    ok((await Enquiry.countDocuments({ "additionalInfo.instagramId": SENDER.nophone })) === 1, "still exactly one lead for that IG sender");

    console.log("\n── Upgrade where the phone already exists → merge, not duplicate ──");
    // A pre-existing phone lead (e.g. a WhatsApp lead) for the same number.
    const waLead = await LeadIntakeService.createLead({ name: "WA Person", phone: `91${P_MERGE}`, source: "whatsapp", additionalInfo: {} });
    // A separate no-number IG contact reaches wedding intent, then shares THAT phone.
    await IG.receiveMessage(SENDER.merge, "hi NOPHONE wedding");
    await IG.receiveMessage(SENDER.merge, "NOPHONE Bengaluru");
    await IG.receiveMessage(SENDER.merge, "NOPHONE planning");
    const igNoNum = await igLead(SENDER.merge);
    ok(!!igNoNum && igNoNum.phone === `ig:${SENDER.merge}`, "second IG contact starts as its own no-number lead");
    await IG.receiveMessage(SENDER.merge, `my number is ${P_MERGE}`);
    const mergeCount = await Enquiry.countDocuments({ phone: `91${P_MERGE}` });
    ok(mergeCount === 1, `phone ${P_MERGE} still belongs to exactly one lead (merged, not duplicated)`);
    const igAfter = await Enquiry.findById(igNoNum._id).lean();
    ok(igAfter.additionalInfo.mergedIntoLeadId === String(waLead._id), "the no-number IG lead is marked merged into the existing phone lead");
    const cm = await conv(SENDER.merge);
    ok(cm && String(cm.enquiryId) === String(waLead._id), "the IG conversation now points to the canonical phone lead");
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
