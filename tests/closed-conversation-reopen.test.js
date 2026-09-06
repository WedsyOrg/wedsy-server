/**
 * A CLOSED CONVERSATION MUST REOPEN WHEN THE CUSTOMER COMES BACK.
 *
 * Production, 6 Sep 2026: 35 closed conversations, 27 of them holding unread
 * customer messages — 154 real messages nobody answered. 17 of those threads are
 * unlinked Instagram, where not even the owner bell fires: total silence.
 *
 * Three links made it: Kiara CLOSES a thread she classifies vendor/birthday/
 * corporate; upsertOnInbound never reopened it; and both agents return early on
 * `status === "closed"`, so she stops replying too. Every UI call site asks for
 * status:"active", so no human sees it either. The design assumed a human would
 * pick these up — the humans could not see them.
 *
 * THE ASSERTIONS ARE CUSTOMER-VISIBLE PROPERTIES, not field flips:
 *   • the thread becomes REACHABLE — present in listInbox({status:"active"}),
 *     the exact call the product makes;
 *   • the customer GETS A REPLY — an assistant message is really persisted,
 *     driven through the real receiveMessage against a scripted model.
 *
 * Born red: both fail before the fix.
 *
 *   node tests/closed-conversation-reopen.test.js
 */
const http = require("http");

const mock = { replies: 0 };
const EXTRACTION = (classification) => ({
  qualified: false, escalate: false, escalateReason: "", classification,
  data: { name: "Test", eventType: "", city: "", eventDate: "", numberOfEvents: "",
          venueStatus: "", venueName: "", servicesRequired: "", budget: "", weddingStyle: "" },
});
let extractorClassification = "lead";

const mockServer = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    if (req.url === "/v1/messages") {
      const isExtractor = String(body.system || "").startsWith("You are a data extractor");
      if (!isExtractor) mock.replies++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "m", stop_reason: "end_turn",
        content: [{ type: "text", text: isExtractor
          ? JSON.stringify(EXTRACTION(extractorClassification))
          : "Of course — tell me more!" }],
      }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: "wamid.mock" }],
                             name: "tester", username: "tester" }));
  });
});

const TAG = `reopen-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.error(`  ✗ ${l}`); } };
const eq = (g, w, l) => ok(g === w, `${l} (got ${JSON.stringify(g)})`);

(async () => {
  await new Promise((r) => mockServer.listen(0, r));
  const port = mockServer.address().port;
  process.env.ANTHROPIC_API_URL = `http://127.0.0.1:${port}/v1/messages`;
  process.env.META_GRAPH_BASE_URL = `http://127.0.0.1:${port}/graph`;
  process.env.INSTAGRAM_GRAPH_BASE_URL = `http://127.0.0.1:${port}/ig`;
  process.env.WHATSAPP_AGENT_PHONE_NUMBER_ID = "mockpnid";
  require("dotenv").config();

  const mongoose = require("mongoose");
  const WAConversation = require("../models/WAConversation");
  const WAAgentMessage = require("../models/WAAgentMessage");
  const Enquiry = require("../models/Enquiry");
  const WAConversationService = require("../services/WAConversationService");
  const InstagramAgentService = require("../services/InstagramAgentService");
  const KiaraCrmSyncService = require("../services/KiaraCrmSyncService");

  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  const cleanup = { convs: [], leads: [] };
  const IG = `${TAG}_ig`;

  const closedThread = async (phone, over = {}) => {
    const c = await WAConversation.create({
      phone, channel: "instagram", profileName: "customer", status: "closed",
      mode: "ai", enquiryId: null, unreadCount: 0,
      lastInboundAt: new Date(Date.now() - 10 * 864e5), ...over,
    });
    cleanup.convs.push(c._id);
    return c;
  };
  const inInbox = async (id) => {
    const r = await WAConversationService.listInbox({ status: "active", limit: 200 }, {});
    return r.list.some((c) => String(c._id) === String(id));
  };

  try {
    console.log("\n1. REACHABLE — the thread appears in the inbox the product asks for");
    {
      const c = await closedThread(IG + "_a");
      eq(await inInbox(c._id), false, "before: a closed thread is NOT in the inbox (the leak)");
      await WAConversationService.recordInbound(c.phone, "hi, are you still there? I want to book", "instagram");
      eq(await inInbox(c._id), true, "AFTER a customer message: the thread IS reachable in the inbox");
    }

    console.log("\n2. ANSWERED — the customer actually gets a reply");
    {
      extractorClassification = "lead";
      const c = await closedThread(IG + "_b");
      mock.replies = 0;
      await InstagramAgentService.receiveMessage(c.phone, "hello? can someone help me");
      const assistant = await WAAgentMessage.countDocuments({ phone: c.phone, role: "assistant" });
      ok(assistant > 0, "an assistant reply is persisted for the reopened thread");
      ok(mock.replies > 0, "…and the model was actually called (not a stale row)");
      const after = await WAConversation.findById(c._id).lean();
      eq(after.status, "active", "…and the thread is left active");
    }

    console.log("\n3. AN OUTBOUND SEND MUST NOT REOPEN A DELIBERATELY CLOSED THREAD");
    {
      const c = await closedThread(IG + "_c");
      const { touchOutbound } = require("../repositories/WAConversationRepository");
      await touchOutbound(c._id, "our own message");
      const after = await WAConversation.findById(c._id).lean();
      eq(after.status, "closed", "touchOutbound leaves a closed thread closed");
      eq(await inInbox(c._id), false, "…and it stays out of the inbox");
    }

    console.log("\n4. PING-PONG IS BOUNDED — the second close escalates instead");
    {
      const c = await closedThread(IG + "_d", { status: "active", reopenedAt: new Date() });
      // A thread a customer has reopened. The classifier says "vendor" again.
      const updated = await KiaraCrmSyncService.applyExtraction(
        await WAConversation.findById(c._id), EXTRACTION("vendor")
      );
      const after = await WAConversation.findById(c._id).lean();
      eq(after.status, "active", "a reopened thread is NOT silently re-closed");
      eq(after.needsHuman, true, "…it is escalated to a human instead");
      ok((after.needsHumanReason || "").length > 0, "…with a reason a person can read");
      eq(await inInbox(c._id), true, "…and it stays reachable");
    }
    {
      // A FIRST close is unchanged — the classifier still does its job.
      const c = await WAConversation.create({
        phone: IG + "_e", channel: "instagram", status: "active", mode: "ai", unreadCount: 0,
      });
      cleanup.convs.push(c._id);
      await KiaraCrmSyncService.applyExtraction(await WAConversation.findById(c._id), EXTRACTION("vendor"));
      const after = await WAConversation.findById(c._id).lean();
      eq(after.status, "closed", "a FIRST close still closes (behaviour preserved)");
      ok(after.closedAt instanceof Date, "…and stamps closedAt");
    }

    console.log("\n5. THE TIMESTAMPS make 'closed then reopened' measurable");
    {
      const c = await closedThread(IG + "_f", { closedAt: new Date(Date.now() - 5 * 864e5) });
      await WAConversationService.recordInbound(c.phone, "still waiting", "instagram");
      const after = await WAConversation.findById(c._id).lean();
      ok(after.reopenedAt instanceof Date, "reopenedAt is stamped on reopen");
      ok(after.closedAt instanceof Date, "…closedAt survives, so the silent interval is recoverable");
      ok(after.reopenedAt > after.closedAt, "…and reopen is after close");
    }

    console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error("suite crashed:", e.message);
    fail++;
  } finally {
    await WAConversation.deleteMany({ phone: new RegExp(`^${TAG}`) });
    await WAAgentMessage.deleteMany({ phone: new RegExp(`^${TAG}`) });
    await Enquiry.deleteMany({ _id: { $in: cleanup.leads } });
    await mongoose.disconnect();
    mockServer.close();
    process.exit(fail === 0 ? 0 : 1);
  }
})();
