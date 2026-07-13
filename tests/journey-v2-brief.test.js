/**
 * Journey v2 — V1: the canonical lead brief.
 *
 *   node tests/journey-v2-brief.test.js
 *
 * • leadBrief null by default; PUT saves { text, savedBy, savedAt } whitelisted
 * • qualifierNoteFeed: legacy string + discovery notes + PRE-qual commented
 *   events only (post-qual notes excluded), authors resolved
 * • AI endpoint returns { text } and NEVER saves
 * • saving auto-completes a name-matched kickoff step + kickoff lane entry +
 *   lead_brief_saved journey event
 */
require("dotenv").config();
const http = require("http");

// Anthropic mock BEFORE requires (anthropicQueue reads the seam at load).
const mock = { calls: [] };
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    mock.calls.push(JSON.parse(raw));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "m", content: [{ type: "text", text: "One tight AI brief paragraph." }], stop_reason: "end_turn" }));
  });
});

const TAG = `jv2brief-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const mockRes = () => ({
  statusCode: 0, body: null,
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; return this; },
  send(b) { this.body = b; return this; },
});

(async () => {
  await new Promise((r) => server.listen(0, r));
  process.env.ANTHROPIC_API_URL = `http://127.0.0.1:${server.address().port}/v1/messages`;

  const mongoose = require("mongoose");
  const Enquiry = require("../models/Enquiry");
  const Admin = require("../models/Admin");
  const LeadInternalEvent = require("../models/LeadInternalEvent");
  const LeadStep = require("../models/LeadStep");
  const LeadLane = require("../models/LeadLane");
  const LaneEntry = require("../models/LaneEntry");
  const LeadBriefService = require("../services/LeadBriefService");
  const leadBriefController = require("../controllers/leadBrief");

  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  const created = { leads: [], admins: [] };
  try {
    const author = await Admin.create({
      name: `${TAG}-asiya`, email: `${TAG}@x.com`, phone: `${TAG}p`, password: "x",
      roles: ["sales"], status: "active",
    });
    created.admins.push(author._id);

    const qualifiedAt = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
    const lead = await Enquiry.create({
      name: `${TAG}-couple`, phone: `${TAG}-ph`, verified: false, isInterested: false,
      isLost: false, stage: "contacted", source: "Default", lostStatus: "none",
      qualified: true, qualifiedAt,
      qualifierNotes: "Bride-led decision, compare with one other planner.",
      qualificationData: { brideName: "Ananya", groomName: "Karthik", weddingStyle: "boho-luxe", additionalNotes: "Family flying from Dubai" },
    });
    created.leads.push(lead._id);

    ok((await Enquiry.findById(lead._id).lean()).leadBrief === null, "leadBrief defaults to null");

    // Notes: one PRE-qual (counts), one POST-qual (excluded).
    await LeadInternalEvent.create({
      leadId: lead._id, type: "commented", actorId: author._id,
      payload: { text: "Saturday sessions in the evening only." },
      createdAt: new Date(+qualifiedAt - 10 * 60 * 1000),
    });
    await LeadInternalEvent.create({
      leadId: lead._id, type: "commented", actorId: author._id,
      payload: { text: "POST-QUAL note — lanes territory." },
      createdAt: new Date(+qualifiedAt + 10 * 60 * 1000),
    });

    const feed = await LeadBriefService.qualifierNoteFeed(lead._id);
    ok(feed.some((n) => n.source === "qualifier" && /Bride-led/.test(n.text)), "feed carries the legacy qualifierNotes string");
    ok(feed.some((n) => n.source === "discovery" && /Dubai/.test(n.text)), "feed carries discovery additionalNotes");
    const noteRows = feed.filter((n) => n.source === "note");
    ok(noteRows.length === 1 && /Saturday sessions/.test(noteRows[0].text),
      "ONLY the pre-qualification commented event is in the feed");
    ok(noteRows[0].author === `${TAG}-asiya` && noteRows[0].when instanceof Date,
      "note rows resolve {author, when}");

    // Kickoff machinery to auto-complete.
    const step = await LeadStep.create({
      leadId: lead._id, name: "Review qualifier notes & pin the lead brief", status: "not_started",
    });
    const lane = await LeadLane.create({
      leadId: lead._id, key: "kickoff", name: "Kickoff & alignment", state: "active",
      lastUpdateAt: new Date(Date.now() - 3 * 24 * 3600 * 1000),
    });

    // AI endpoint: returns text, saves NOTHING.
    const resAi = mockRes();
    await leadBriefController.AiSuggest({ params: { _id: String(lead._id) }, auth: { user_id: String(author._id) } }, resAi);
    ok(resAi.statusCode === 200 && resAi.body.text === "One tight AI brief paragraph.",
      `AI endpoint returns { text } (got ${resAi.statusCode})`);
    ok((await Enquiry.findById(lead._id).lean()).leadBrief === null, "AI endpoint NEVER auto-saves the brief");
    const aiCall = mock.calls[mock.calls.length - 1];
    ok(/Saturday sessions/.test(JSON.stringify(aiCall)) && /boho-luxe/.test(JSON.stringify(aiCall)),
      "AI input includes qualifier notes + discovery fields");

    // Save.
    const resSave = mockRes();
    await leadBriefController.Save(
      { params: { _id: String(lead._id) }, body: { text: "  The one canonical brief.  " }, auth: { user_id: String(author._id) } },
      resSave
    );
    ok(resSave.statusCode === 200, `PUT lead-brief → 200 (got ${resSave.statusCode})`);
    const after = await Enquiry.findById(lead._id).lean();
    ok(after.leadBrief && after.leadBrief.text === "The one canonical brief." &&
       String(after.leadBrief.savedBy) === String(author._id) && after.leadBrief.savedAt,
      "leadBrief saved { text (trimmed), savedBy, savedAt }");
    ok(await LeadInternalEvent.exists({ leadId: lead._id, type: "lead_brief_saved" }),
      "journey event lead_brief_saved recorded");
    ok((await LeadStep.findById(step._id).lean()).status === "complete",
      "name-matched kickoff step auto-completed");
    ok(await LaneEntry.exists({ laneId: lane._id, autoType: "brief_saved" }),
      "kickoff lane got the brief_saved auto entry");

    // Guards.
    const resEmpty = mockRes();
    await leadBriefController.Save({ params: { _id: String(lead._id) }, body: { text: "  " }, auth: { user_id: String(author._id) } }, resEmpty);
    ok(resEmpty.statusCode === 400, "empty text → 400");

    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    const mongoose = require("mongoose");
    const Enquiry = require("../models/Enquiry");
    const Admin = require("../models/Admin");
    const LeadInternalEvent = require("../models/LeadInternalEvent");
    const LeadStep = require("../models/LeadStep");
    const LeadLane = require("../models/LeadLane");
    const LaneEntry = require("../models/LaneEntry");
    await LaneEntry.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await LeadLane.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await LeadStep.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await LeadInternalEvent.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
    await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
    await mongoose.disconnect();
    server.close();
    process.exit(fail ? 1 : 0);
  }
})();
