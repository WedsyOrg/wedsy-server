/**
 * THE GOOGLE CHAT PING FOR A NEW LEAD.
 *
 * Make owns this today. Nothing in this server could replace it — the audit
 * found no Google Chat code anywhere — which is one of the two things blocking
 * Make's removal. This is that capability, built to sit dormant until someone
 * turns it on, because Make is STILL POSTING and a live double-notify would be
 * a worse outcome than the gap.
 *
 * What is asserted here:
 *   A  inert with no webhook configured — no request, and it says why
 *   B  configured — one POST, carrying the things a person needs to act
 *   C  the deep link comes from env, not a literal
 *   D  the webhook URL never reaches a log line or an error message
 *   E  a Chat outage cannot fail or delay a lead being created
 *   F  the words live in a pure function, reachable without the transport
 *
 * Nothing here can reach the network: fetch is replaced before the service is
 * loaded, and the "URL" is a stub.
 *
 *   node tests/chat-notify-new-lead.test.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.error(`  ✗ ${l}`); } };
const eq = (g, w, l) => ok(g === w, `${l}${g === w ? "" : `\n      expected ${JSON.stringify(w)}\n      got      ${JSON.stringify(g)}`}`);

// Safe require: a capability that does not exist yet should fail ASSERTION BY
// ASSERTION, not crash the suite on line one.
const tryRequire = (p) => { try { return require(p); } catch { return null; } };

const STUB_URL = "https://chat.googleapis.com/v1/spaces/AAAA/messages?key=SECRETKEY123&token=SECRETTOKEN456";

const realFetch = global.fetch;
let posted = [];
let fetchBehaviour = async () => new Response(JSON.stringify({ name: "spaces/AAAA/messages/BBBB" }), { status: 200 });
global.fetch = async (url, opts) => { posted.push({ url: String(url), opts }); return fetchBehaviour(url, opts); };

let logs = [];
const realLog = console.log, realErr = console.error;
console.log = (...a) => { logs.push(a.join(" ")); realLog(...a); };
console.error = (...a) => { logs.push(a.join(" ")); realErr(...a); };
const reset = () => { posted = []; logs = []; };

const ChatNotify = tryRequire("../services/GoogleChatNotifyService");
const chatMessages = tryRequire("../utils/chatMessages");
const Enquiry = require("../models/Enquiry");

const TAG = `chatnotify-${Date.now()}`;
const cleanup = [];
const ORIGINAL = {
  hook: process.env.GOOGLE_CHAT_LEADS_WEBHOOK_URL,
  os: process.env.OS_FRONTEND_URL,
};

const sampleLead = (over = {}) => ({
  _id: "6aa03d362c0ca70189c8879c",
  name: "Priya & Arjun",
  phone: "+919876543210",
  source: "facebook_june_decor",
  ...over,
});

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    ok(!!ChatNotify, "services/GoogleChatNotifyService exists");
    ok(!!chatMessages, "utils/chatMessages exists");
    if (!ChatNotify || !chatMessages) throw new Error("capability not built yet — remaining assertions cannot run");

    // ══ F. THE WORDS, ISOLATED ═══════════════════════════════════════════════
    console.log("\nF. THE MESSAGE IS A PURE FUNCTION");
    {
      const { newLeadChatMessage } = chatMessages;
      ok(typeof newLeadChatMessage === "function", "newLeadChatMessage is exported");
      if (typeof newLeadChatMessage === "function") {
        // The function takes the LEAD and decides which lines it can fill.
        // Per-source rendering is covered in full by chat-notify-sources.test.js;
        // what this suite owns is that the transport carries what it produces.
        const args = {
          lead: {
            _id: "abc123",
            name: "Priya & Arjun",
            phone: "+919876543210",
            source: "facebook_june_decor",
            createdAt: new Date("2026-09-10T12:00:00Z"),
          },
          assignedToName: "Anita",
          leadUrl: "https://os.example/leads/abc123",
          now: new Date("2026-09-10T12:00:00Z"),
        };
        const a = newLeadChatMessage(args);
        const b = newLeadChatMessage(args);
        eq(a, b, "it is pure — same input, same output");
        ok(typeof a === "string" && a.length > 0, "it returns a non-empty string");
        ok(a.includes("Priya & Arjun"), "the lead's name is in it");
        ok(a.includes("+919876543210"),
          "the FULL phone is in it, unmasked — staff copy it to dial");
        ok(!/\*{3,}|x{4,}|X{4,}/.test(a), "…and nothing in it is masked");
        // The RAW slug is deliberately no longer shown — sourceLabel() humanises
        // it (asserted in full by tests/chat-notify-sources.test.js). What this
        // suite still owns is that the source reaches the message at all.
        ok(a.includes("Facebook Ad — June Decor"), "the source is in it, in human words");
        ok(!a.includes("facebook_june_decor"), "…and not as the raw stored slug");
        ok(a.includes("Anita"), "who it was assigned to is in it");
        ok(a.includes("https://os.example/leads/abc123"), "and the link to the lead");

        const unassigned = newLeadChatMessage({ ...args, assignedToName: null });
        ok(typeof unassigned === "string" && unassigned.length > 0,
          "an UNASSIGNED lead still produces a message");
        ok(!unassigned.includes("null") && !unassigned.includes("undefined"),
          "…with no 'null' or 'undefined' leaking into what a person reads");
      }
    }

    // ══ A. INERT BY DEFAULT ══════════════════════════════════════════════════
    console.log("\nA. INERT UNTIL CONFIGURED (Make is still posting today)");
    {
      reset();
      delete process.env.GOOGLE_CHAT_LEADS_WEBHOOK_URL;
      const res = await ChatNotify.notifyNewLead(sampleLead(), { assignedToName: "Anita" });
      eq(posted.length, 0, "with no webhook configured, NOTHING is posted");
      ok(logs.some((l) => l.includes("SKIPPED")), "…and it logs that it skipped");
      ok(logs.some((l) => l.toLowerCase().includes("not configured")), "…with the reason");
      ok(res && res.sent === false, "…and reports sent:false rather than pretending");
    }

    // ══ B. CONFIGURED — ONE POST, WITH WHAT A PERSON NEEDS ═══════════════════
    console.log("\nB. CONFIGURED — IT POSTS");
    {
      reset();
      process.env.GOOGLE_CHAT_LEADS_WEBHOOK_URL = STUB_URL;
      process.env.OS_FRONTEND_URL = "https://os.example";
      const res = await ChatNotify.notifyNewLead(sampleLead(), { assignedToName: "Anita" });
      eq(posted.length, 1, "exactly one POST");
      const req = posted[0] || { url: "", opts: {} };
      eq(req.url, STUB_URL, "to the configured webhook");
      eq(req.opts.method, "POST", "as a POST");
      const body = JSON.parse(req.opts.body || "{}");
      ok(typeof body.text === "string" && body.text.length > 0, "with a text body");
      ok(body.text.includes("Priya & Arjun"), "…carrying the lead name");
      ok(body.text.includes("+919876543210"), "…the full phone");
      ok(body.text.includes("Facebook Ad — June Decor"), "…the source, humanised");
      ok(body.text.includes("Anita"), "…the assignee");
      ok(body.text.includes("https://os.example/leads/6aa03d362c0ca70189c8879c"),
        "…and a deep link to that exact lead");
      ok(res && res.sent === true, "and it reports sent:true");
    }

    // ══ C. THE LINK IS NOT HARDCODED ═════════════════════════════════════════
    console.log("\nC. THE DEEP LINK COMES FROM ENV");
    {
      reset();
      process.env.OS_FRONTEND_URL = "https://staging.os.example";
      await ChatNotify.notifyNewLead(sampleLead(), { assignedToName: "Anita" });
      const body = JSON.parse((posted[0] || { opts: {} }).opts.body || "{}");
      ok(body.text.includes("https://staging.os.example/leads/"),
        "changing OS_FRONTEND_URL changes the link — it is read, not baked in");
      ok(!body.text.includes("https://os.example/leads/"), "…and the old base is gone");
      process.env.OS_FRONTEND_URL = "https://os.example";
    }

    // ══ D. THE WEBHOOK URL IS A SECRET ═══════════════════════════════════════
    console.log("\nD. THE URL NEVER REACHES A LOG OR AN ERROR");
    {
      reset();
      fetchBehaviour = async () => { throw new Error(`connect ECONNREFUSED for ${STUB_URL}`); };
      let thrown = null;
      try { await ChatNotify.notifyNewLead(sampleLead(), { assignedToName: "Anita" }); }
      catch (e) { thrown = e; }
      eq(thrown, null, "a transport failure does not throw out of the service");
      const all = logs.join("\n");
      ok(!all.includes("SECRETKEY123"), "the webhook key is not in any log line");
      ok(!all.includes("SECRETTOKEN456"), "the webhook token is not either");
      ok(!all.includes(STUB_URL), "nor the whole URL");
      ok(logs.some((l) => l.includes("FAILED")), "…but the failure IS reported");

      reset();
      fetchBehaviour = async () => new Response("nope", { status: 500 });
      await ChatNotify.notifyNewLead(sampleLead(), { assignedToName: "Anita" });
      const all2 = logs.join("\n");
      ok(!all2.includes("SECRETKEY123") && !all2.includes(STUB_URL),
        "a non-2xx response also logs without the URL");
      ok(logs.some((l) => l.includes("500")), "…and names the status");

      fetchBehaviour = async () => new Response(JSON.stringify({ name: "ok" }), { status: 200 });
    }

    // ══ E. A CHAT OUTAGE CANNOT BREAK LEAD CREATION ══════════════════════════
    console.log("\nE. LEAD CREATION SURVIVES A CHAT OUTAGE");
    {
      reset();
      // The harshest version: the send does not merely fail, it THROWS
      // synchronously, before any promise exists to catch.
      const realNotify = ChatNotify.notifyNewLead;
      ChatNotify.notifyNewLead = () => { throw new Error("Chat is down"); };
      try {
        const LeadIntakeService = require("../services/LeadIntakeService");
        const phone = `9198765${String(Date.now()).slice(-5)}`;
        let threw = null;
        let created = null;
        try {
          created = await LeadIntakeService.createLead({
            name: `${TAG}-lead`, phone, verified: false, source: "facebook_june_decor", additionalInfo: {},
          });
          if (created) cleanup.push(created._id);
        } catch (e) { threw = e; }
        eq(threw, null, "createLead did not throw");
        ok(!!created, "…the lead was created");
        if (created) {
          const found = await Enquiry.findById(created._id).lean();
          ok(!!found, "…and it is in the database");
          eq(found && found.stage, "new", "…with its normal create-path defaults intact");
        }
      } finally {
        ChatNotify.notifyNewLead = realNotify;
      }
    }

    // ══ G. THE SAFETY PROPERTY, END TO END ═══════════════════════════════════
    console.log("\nG. A REAL LEAD CREATION POSTS NOTHING WHILE UNCONFIGURED");
    {
      // The one that protects the team's inbox. Make is still posting, so a
      // create must reach Chat only after someone deliberately sets the env
      // var — asserted through the ACTUAL afterCreate path, not the service.
      reset();
      delete process.env.GOOGLE_CHAT_LEADS_WEBHOOK_URL;
      const LeadIntakeService = require("../services/LeadIntakeService");
      const phone = `9198764${String(Date.now()).slice(-5)}`;
      const created = await LeadIntakeService.createLead({
        name: `${TAG}-inert`, phone, verified: false, source: "facebook_june_decor", additionalInfo: {},
      });
      if (created) cleanup.push(created._id);
      await new Promise((r) => setTimeout(r, 150));
      eq(posted.length, 0, "creating a real lead posts NOTHING to Chat");
      ok(logs.some((l) => l.includes("SKIPPED") && l.includes("not configured")),
        "…and the skip names the reason, so it is obvious why the team sees nothing");

      // And with it configured, the same path DOES post — proving the wiring
      // is live and only the env var is holding it back.
      reset();
      process.env.GOOGLE_CHAT_LEADS_WEBHOOK_URL = STUB_URL;
      const phone2 = `9198763${String(Date.now()).slice(-5)}`;
      const created2 = await LeadIntakeService.createLead({
        name: `${TAG}-live`, phone: phone2, verified: false, source: "facebook_june_decor", additionalInfo: {},
      });
      if (created2) cleanup.push(created2._id);
      await new Promise((r) => setTimeout(r, 150));
      eq(posted.length, 1, "with the webhook set, the same path DOES post");
      const body = JSON.parse((posted[0] || { opts: {} }).opts.body || "{}");
      ok(body.text.includes(`${TAG}-live`), "…about the lead that was just created");
      ok(body.text.includes(String(created2._id)), "…linking to its real id");
    }

    console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error("suite stopped:", e && e.message ? e.message : e);
    fail++;
  } finally {
    console.log = realLog; console.error = realErr;
    global.fetch = realFetch;
    if (ORIGINAL.hook === undefined) delete process.env.GOOGLE_CHAT_LEADS_WEBHOOK_URL;
    else process.env.GOOGLE_CHAT_LEADS_WEBHOOK_URL = ORIGINAL.hook;
    if (ORIGINAL.os === undefined) delete process.env.OS_FRONTEND_URL;
    else process.env.OS_FRONTEND_URL = ORIGINAL.os;
    if (cleanup.length) await Enquiry.deleteMany({ _id: { $in: cleanup } });
    await Enquiry.deleteMany({ name: new RegExp(`^${TAG}`) });
    await mongoose.disconnect();
    process.exit(fail === 0 ? 0 : 1);
  }
})();
