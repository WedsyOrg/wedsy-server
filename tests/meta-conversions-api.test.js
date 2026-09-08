/**
 * META CONVERSIONS API — the qualification signal that goes back to Meta.
 *
 * G1  a qualified Meta-sourced lead POSTs to the events endpoint with all four
 *     required fields present
 * G2  a qualified NON-Meta lead produces NO request, and logs why
 * G3  em and ph are SHA-256 hex of the normalised values, checked against
 *     vectors computed HERE — never by calling the code's own normaliser
 * G4  Meta returning 500 does not fail the qualification
 * G5  the same lead qualified twice sends at most one event
 *
 * G3 is computed independently on purpose. A gate that hashes with the same
 * helper the code hashes with proves the helper is self-consistent and nothing
 * else — it would pass just as happily if the normalisation were wrong in both
 * places. The expected digests below are literals.
 *
 *   node tests/meta-conversions-api.test.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const crypto = require("crypto");

const Enquiry = require("../models/Enquiry");
const MetaCAPI = require("../services/MetaConversionsService");
const LeadLifecycleService = require("../services/LeadLifecycleService");

const TAG = `capi-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.error(`  ✗ ${l}`); } };
const eq = (g, w, l) => ok(g === w, `${l}${g === w ? "" : `\n      expected ${JSON.stringify(w)}\n      got      ${JSON.stringify(g)}`}`);
const cleanup = [];
let seq = 0;

// ── Test double for the network. Records every attempt; never touches Meta. ──
const realFetch = global.fetch;
let captured = [];
let respondWith = { ok: true, status: 200, json: async () => ({ events_received: 1 }) };
const installFetchSpy = () => {
  global.fetch = async (url, opts) => {
    captured.push({ url: String(url), body: JSON.parse(opts.body), method: opts.method });
    return respondWith;
  };
};
// Console capture, so G2 can assert the skip was actually EXPLAINED.
let logs = [];
const realLog = console.log;
const installLogSpy = () => { console.log = (...a) => { logs.push(a.join(" ")); realLog(...a); }; };

const seedLead = async (over = {}) => {
  const l = await Enquiry.create({
    name: `${TAG}-lead`,
    phone: `9198765${String(++seq).padStart(5, "0")}`,
    source: "facebook_june_decor",
    stage: "new", verified: false, isInterested: false, isLost: false,
    ...over,
  });
  cleanup.push(l._id);
  return l;
};
const settle = () => new Promise((r) => setTimeout(r, 250));

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    process.env.META_CAPI_DATASET_ID = "TEST_DATASET";
    process.env.META_CAPI_ACCESS_TOKEN = "TEST_TOKEN_SHOULD_NEVER_BE_LOGGED";
    delete process.env.META_CAPI_TEST_EVENT_CODE;
    installFetchSpy();
    installLogSpy();

    // ══ G3 first: the hashing contract, independent of any lead ═════════════
    console.log("\nG3  HASHING — asserted against independently computed vectors");
    {
      // Meta's rule for em: trim, lowercase, then SHA-256 hex.
      // Computed here, from the literal normalised string, NOT via the service.
      const EMAIL_RAW = "  Test@Example.COM ";
      const EMAIL_NORMALISED = "test@example.com";
      const EMAIL_SHA256 = crypto.createHash("sha256").update(EMAIL_NORMALISED, "utf8").digest("hex");
      // Pinned literal — if the normalisation silently changes, this fails even
      // if both sides change together.
      eq(EMAIL_SHA256, "973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b",
        "the email vector itself is the known SHA-256 of \"test@example.com\"");

      // Meta's rule for ph: strip symbols, letters and leading zeros; country
      // code must be present. "+91 98765 43210" -> "919876543210".
      const PHONE_RAW = "+91 98765 43210";
      const PHONE_NORMALISED = "919876543210";
      const PHONE_SHA256 = crypto.createHash("sha256").update(PHONE_NORMALISED, "utf8").digest("hex");

      const lead = { _id: "abc123", email: EMAIL_RAW, phone: PHONE_RAW, qualifiedAt: new Date() };
      const { event } = MetaCAPI.buildEvent(lead);

      eq(event.user_data.em, EMAIL_SHA256, "em is SHA-256 of the trimmed, lowercased email");
      eq(event.user_data.ph, PHONE_SHA256, "ph is SHA-256 of the digits-only phone with country code");
      ok(!JSON.stringify(event).includes("Test@Example"), "the raw email never appears in the payload");
      ok(!JSON.stringify(event).includes("98765 43210"), "the raw phone never appears in the payload");
      ok(/^[a-f0-9]{64}$/.test(event.user_data.em) && /^[a-f0-9]{64}$/.test(event.user_data.ph),
        "both identifiers are 64-char lowercase hex");

      // Leading zeros and a missing country code, per the same rule.
      eq(MetaCAPI.normalisePhone("09876543210"), "919876543210", "a leading zero is stripped, country code added");
      eq(MetaCAPI.normalisePhone("98765-43210"), "919876543210", "symbols are stripped from a bare local number");
      eq(MetaCAPI.normalisePhone("ig:17841400000001"), null,
        "an \"ig:\" placeholder is NOT a phone number and is never hashed");
      eq(MetaCAPI.normaliseEmail("  Test@Example.COM "), "test@example.com", "email normalisation trims and lowercases");
      eq(MetaCAPI.normaliseEmail("not-an-email"), null, "a non-address is not hashed into a junk identifier");
    }

    // ══ G1 ══════════════════════════════════════════════════════════════════
    console.log("\nG1  A QUALIFIED META-SOURCED LEAD SENDS THE EVENT");
    {
      captured = []; logs = [];
      const lead = await seedLead({ source: "facebook_june_decor", email: "bride@example.com" });
      await LeadLifecycleService.qualifyLead(lead._id, null);
      await settle();

      eq(captured.length, 1, "exactly one POST was made");
      const req = captured[0] || { url: "", body: {} };
      ok(req.url.startsWith(`https://graph.facebook.com/${MetaCAPI.API_VERSION}/TEST_DATASET/events`),
        `it went to the v25.0 /{DATASET_ID}/events endpoint`);
      eq(req.method, "POST", "as a POST");

      const ev = (req.body.data || [])[0] || {};
      eq(ev.event_name, "Qualified Lead", "event_name");
      eq(ev.action_source, "system_generated", "action_source — required for a CRM lead event");
      eq(ev.custom_data && ev.custom_data.event_source, "crm", "custom_data.event_source — equally required");
      eq(ev.custom_data && ev.custom_data.lead_event_source, "Wedsy OS", "custom_data.lead_event_source");
      ok(Number.isInteger(ev.event_time) && String(ev.event_time).length === 10,
        `event_time is unix SECONDS, not milliseconds (${ev.event_time})`);
      const dbLead = await Enquiry.findById(lead._id).lean();
      eq(ev.event_time, Math.floor(new Date(dbLead.qualifiedAt).getTime() / 1000),
        "…and it is when qualification happened, not when the request was built");
      ok(typeof ev.event_id === "string" && ev.event_id.length > 0, "event_id is present");

      // The identifier rules, on the wire.
      ok(ev.user_data && ev.user_data.ph && ev.user_data.em, "user_data carries both em and ph");
      ok(!("lead_id" in (ev.user_data || {})) && !("lead_id" in ev),
        "lead_id is NOT sent — we do not have Meta's, and the ad id is not a substitute");

      // The token is a secret.
      ok(!logs.join("\n").includes("TEST_TOKEN_SHOULD_NEVER_BE_LOGGED"),
        "the access token never appears in a log line");
      ok(logs.some((l) => l.includes("SENDING") && l.includes("identifiers=[")),
        "the attempt is logged with the identifiers used");
      ok(logs.some((l) => l.includes("SENT — HTTP 200")), "and the outcome is logged as sent");
    }

    // ══ G2 ══════════════════════════════════════════════════════════════════
    console.log("\nG2  A QUALIFIED NON-META LEAD SENDS NOTHING, AND SAYS WHY");
    for (const [source, extra, why] of [
      ["Website", {}, "a website lead"],
      ["Wedding Requirements Form", {}, "the wedding requirements form"],
      ["User Signup (Account Creation)", {}, "a user signup"],
      ["Instagram DM", {}, "an Instagram DM lead"],
      ["whatsapp", {}, "a WhatsApp lead"],
      ["landing_page", {}, "the bridge's explicit non-ad value"],
      ["Ads (Landing Screen)", {}, "the ambiguous historical default"],
      ["instagram", { additionalInfo: { instagramId: "17841400000001" } }, "an ORGANIC Instagram DM (same source string as an IG ad)"],
    ]) {
      captured = []; logs = [];
      const lead = await seedLead({ source, ...extra });
      await LeadLifecycleService.qualifyLead(lead._id, null);
      await settle();
      eq(captured.length, 0, `${why} → no request`);
      ok(logs.some((l) => l.includes("SKIPPED") && l.includes("lead=" + String(lead._id))),
        `…and the skip is logged with a reason`);
      const stillQualified = await Enquiry.findById(lead._id).lean();
      ok(stillQualified.qualified === true, `…and the lead still qualified`);
    }
    {
      // "Meta Ads" — one qualified lead on production, unambiguous. Allowed by
      // the census ruling; it does not fit the campaign-label shape, so it is a
      // literal and needs its own gate.
      captured = [];
      const lead = await seedLead({ source: "Meta Ads" });
      await LeadLifecycleService.qualifyLead(lead._id, null);
      await settle();
      eq(captured.length, 1, '"Meta Ads" DOES send — allowed by the census ruling');

      captured = [];
      const lead2 = await seedLead({ source: "meta ads" });
      await LeadLifecycleService.qualifyLead(lead2._id, null);
      await settle();
      eq(captured.length, 1, "…and a case variant is not a silent miss");
    }
    {
      // The counterpart: an Instagram AD lead has no DM fingerprint and DOES send.
      captured = []; logs = [];
      const lead = await seedLead({ source: "instagram", additionalInfo: { adFormAnswers: { city: "Mysore" } } });
      await LeadLifecycleService.qualifyLead(lead._id, null);
      await settle();
      eq(captured.length, 1, "an Instagram AD-FORM lead (no instagramId) DOES send");
    }

    // ══ G4 ══════════════════════════════════════════════════════════════════
    console.log("\nG4  META FAILING DOES NOT FAIL THE QUALIFICATION");
    {
      captured = []; logs = [];
      respondWith = {
        ok: false, status: 500,
        json: async () => ({ error: { message: "Internal error", fbtrace_id: "AbCdEf123" } }),
      };
      const lead = await seedLead({ source: "facebook" });
      let threw = null;
      try { await LeadLifecycleService.qualifyLead(lead._id, null); } catch (e) { threw = e; }
      await settle();

      eq(threw, null, "qualifyLead did not throw");
      const after = await Enquiry.findById(lead._id).lean();
      ok(after.qualified === true, "the lead IS qualified");
      ok(!!after.qualifiedAt, "…and qualifiedAt was stamped");
      ok(logs.some((l) => l.includes("FAILED") && l.includes("HTTP 500")), "the failure is logged as a FAILURE");
      ok(logs.some((l) => l.includes("fbtrace_id=AbCdEf123")), "…carrying Meta's fbtrace_id for diagnosis");
      ok(!logs.some((l) => l.includes("SENT — HTTP 500")), "a failed attempt is never logged as a success");

      // And a hard network failure, which is a different code path.
      captured = []; logs = [];
      global.fetch = async () => { throw new Error("ECONNREFUSED"); };
      const lead2 = await seedLead({ source: "facebook" });
      let threw2 = null;
      try { await LeadLifecycleService.qualifyLead(lead2._id, null); } catch (e) { threw2 = e; }
      await settle();
      eq(threw2, null, "a network error does not throw out of qualifyLead either");
      ok((await Enquiry.findById(lead2._id).lean()).qualified === true, "…and that lead is qualified too");

      installFetchSpy();
      respondWith = { ok: true, status: 200, json: async () => ({ events_received: 1 }) };
    }

    // ══ G5 ══════════════════════════════════════════════════════════════════
    console.log("\nG5  QUALIFYING TWICE SENDS AT MOST ONE EVENT");
    {
      captured = []; logs = [];
      const lead = await seedLead({ source: "facebook_june_decor" });
      await LeadLifecycleService.qualifyLead(lead._id, null);
      await settle();
      await LeadLifecycleService.qualifyLead(lead._id, null);
      await settle();
      eq(captured.length, 1, "two qualify calls, one POST — the send sits after the idempotent early return");

      // Belt and braces: even if a send did escape twice, event_id collapses it.
      const a = MetaCAPI.eventIdFor(lead._id);
      const b = MetaCAPI.eventIdFor(lead._id);
      eq(a, b, "event_id is stable for a given lead, so a retry cannot double-count");
      ok(a.includes(String(lead._id)), "…and is derived from the lead id and the event name");
    }

    // ══ The two config states Rohaan will actually meet first ══════════════
    console.log("\nG6  CONFIG STATES — the test-event path is the FIRST one used live");
    {
      // With META_CAPI_TEST_EVENT_CODE set the event goes to Events Manager's
      // Test Events view only and must NOT affect real data. This is the exact
      // path the first live send uses, so it is gated rather than assumed.
      captured = []; logs = [];
      process.env.META_CAPI_TEST_EVENT_CODE = "TEST12345";
      const lead = await seedLead({ source: "facebook_june_decor" });
      await LeadLifecycleService.qualifyLead(lead._id, null);
      await settle();
      eq(captured.length, 1, "the event is still sent");
      eq((captured[0] || { body: {} }).body.test_event_code, "TEST12345",
        "test_event_code rides at the TOP level of the body, beside data[]");
      ok(logs.some((l) => l.includes("TEST EVENT")), "…and the log says it was a test event");
      delete process.env.META_CAPI_TEST_EVENT_CODE;

      captured = [];
      const lead2 = await seedLead({ source: "facebook_june_decor" });
      await LeadLifecycleService.qualifyLead(lead2._id, null);
      await settle();
      ok(!("test_event_code" in ((captured[0] || { body: {} }).body)),
        "with the code UNSET, no test_event_code is sent at all");
    }
    {
      // Unconfigured is the state every environment starts in — it must skip
      // quietly-but-loudly, never crash a qualification.
      captured = []; logs = [];
      const ds = process.env.META_CAPI_DATASET_ID;
      delete process.env.META_CAPI_DATASET_ID;
      const lead = await seedLead({ source: "facebook_june_decor" });
      let threw = null;
      try { await LeadLifecycleService.qualifyLead(lead._id, null); } catch (e) { threw = e; }
      await settle();
      eq(threw, null, "an unconfigured environment does not break qualification");
      eq(captured.length, 0, "…and sends nothing");
      ok(logs.some((l) => l.includes("SKIPPED") && l.includes("not configured")), "…and says it is not configured");
      ok((await Enquiry.findById(lead._id).lean()).qualified === true, "…and the lead still qualified");
      process.env.META_CAPI_DATASET_ID = ds;
    }

    console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error("suite crashed:", e && e.stack ? e.stack : e);
    fail++;
  } finally {
    console.log = realLog;
    global.fetch = realFetch;
    if (cleanup.length) await Enquiry.deleteMany({ _id: { $in: cleanup } });
    await Enquiry.deleteMany({ name: new RegExp(`^${TAG}`) });
    await mongoose.disconnect();
    process.exit(fail === 0 ? 0 : 1);
  }
})();
