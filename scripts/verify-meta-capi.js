/* VERIFY THE META CONVERSIONS API INTEGRATION — re-runnable, against production.
 *
 * READ-ONLY against MongoDB and DRY by default. It reads leads, rebuilds the
 * payload the live code would send, and shows it to you. It writes nothing to
 * the database in either mode, and it sends nothing to Meta unless you ask.
 *
 *   node scripts/verify-meta-capi.js
 *       How many qualified leads the gate would send for, and the EXACT payload
 *       buildEvent() produces for one of them. Sends nothing. Exits 0.
 *
 *   node scripts/verify-meta-capi.js --lead <id>
 *       The same, for a lead you name.
 *
 *   node scripts/verify-meta-capi.js --send --lead <id>
 *       Sends that ONE lead through the real sendQualifiedLead(), and reports
 *       what META ACTUALLY RETURNED. REFUSES to run unless
 *       META_CAPI_TEST_EVENT_CODE is set.
 *
 * TWO RULES THIS FILE EXISTS TO KEEP.
 *
 * 1. IT REPORTS THE ARTIFACT, NOT THE CALL. sendQualifiedLead() resolving
 *    without throwing proves nothing — it is deliberately built never to throw.
 *    Even `sent: true` only means Meta answered 2xx. A 200 carrying
 *    events_received: 0 is Meta telling us the event was DROPPED, and this
 *    script calls that a FAILURE and exits non-zero. The verification is what
 *    came back over the wire, which is why the response is captured directly
 *    rather than inferred from the return value.
 *
 * 2. IT NEVER PRINTS A SECRET OR A WHOLE CUSTOMER HASH. The access token is
 *    scrubbed from every line this script emits, including any Meta echoes back
 *    at us. Hashed identifiers are truncated to 8 characters: enough to compare
 *    two runs, useless for recovering a customer's phone number. A full SHA-256
 *    of a phone is a stable, reversible-by-lookup identifier for a real person,
 *    and it does not belong in a terminal scrollback or a pasted bug report.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};

const SEND = has("--send");
const LEAD_ID = valueOf("--lead");

// ── Output that cannot leak the token ──────────────────────────────────────
// Every line goes through here. The token is redacted even when it arrives
// inside something Meta echoed back, and even in an error stack.
const TOKEN = process.env.META_CAPI_ACCESS_TOKEN || "";
// Only substring-scrub a token long enough to BE one. A short value (a stub
// like "T" in a local check) is not a secret, and blind-replacing it shreds
// every message that happens to contain that letter — including the refusal
// text explaining why the run stopped. Real Meta tokens are ~200 chars.
const SCRUBBABLE = TOKEN.length >= 12 ? TOKEN : "";
const scrub = (s) => {
  let out = String(s);
  if (SCRUBBABLE) out = out.split(SCRUBBABLE).join("<META_CAPI_ACCESS_TOKEN redacted>");
  // Belt and braces: anything that looks like an access_token query parameter,
  // whatever its value, in case a different token reaches the output.
  return out.replace(/access_token=[^&\s"']+/gi, "access_token=<redacted>");
};
const say = (...parts) => console.log(scrub(parts.join(" ")));
const err = (...parts) => console.error(scrub(parts.join(" ")));

// Truncate every 64-char hex digest anywhere in a structure.
const HEX64 = /^[a-f0-9]{64}$/i;
const truncateHashes = (value) => {
  if (Array.isArray(value)) return value.map(truncateHashes);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = truncateHashes(v);
    return out;
  }
  if (typeof value === "string" && HEX64.test(value)) return `${value.slice(0, 8)}… (truncated)`;
  return value;
};

const rule = (label = "") =>
  say(label ? `\n── ${label} ${"─".repeat(Math.max(0, 66 - label.length))}` : "─".repeat(70));

(async () => {
  let exitCode = 0;
  let connected = false;

  try {
    if (!process.env.DATABASE_URL) {
      err("DATABASE_URL is not set — refusing to run.");
      process.exit(1);
    }

    // ── Refuse the unsafe combination BEFORE touching anything ──────────────
    // Checked first, so an operator who typed the wrong command is stopped
    // before a connection is opened, not after.
    if (SEND) {
      if (!process.env.META_CAPI_TEST_EVENT_CODE) {
        err("REFUSING TO SEND — META_CAPI_TEST_EVENT_CODE is not set.");
        err("");
        err("  A verification script does not put live events into the optimisation");
        err("  data. With the test code set, the event lands in Events Manager →");
        err("  Test Events and affects nothing else.");
        err("");
        err("  Set META_CAPI_TEST_EVENT_CODE (from Events Manager → Test Events)");
        err("  and run this again.");
        process.exit(2);
      }
      if (!LEAD_ID) {
        err("REFUSING TO SEND — --send requires --lead <id>.");
        err("  This script sends for exactly one named lead, never a batch.");
        process.exit(2);
      }
    }

    const MetaCAPI = require("../services/MetaConversionsService");
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    connected = true;
    const Enquiry = require("../models/Enquiry");

    const host = String(process.env.DATABASE_URL).replace(/\/\/[^@]*@/, "//<redacted>@").split("/").slice(0, 3).join("/");
    rule();
    say("META CONVERSIONS API — VERIFICATION");
    rule();
    say(`  database        ${host}  (READ-ONLY — this script writes nothing)`);
    say(`  mode            ${SEND ? "SEND (one lead, test event)" : "DRY — nothing will be sent"}`);
    say(`  dataset id      ${process.env.META_CAPI_DATASET_ID || "(unset)"}`);
    say(`  access token    ${TOKEN ? `set, ${TOKEN.length} chars (never printed)` : "(unset)"}`);
    say(`  test event code ${process.env.META_CAPI_TEST_EVENT_CODE || "(unset — real events)"}`);
    say(`  default cc      ${process.env.DEFAULT_COUNTRY_CODE || "91 (fallback)"}`);

    if (!process.env.META_CAPI_DATASET_ID || !TOKEN) {
      say("");
      say("  NOTE: the integration is INERT here — with either of those unset the");
      say("        service skips every lead. The payload preview below still shows");
      say("        what it WOULD send once configured.");
    }

    // ── 1. Who the gate would send for ─────────────────────────────────────
    // metaAdOrigin() is imported from the live service rather than
    // reimplemented: a verifier with its own copy of the rule verifies its own
    // copy, not the thing that is deployed.
    rule("1. WHO THE GATE WOULD SEND FOR");
    const qualified = await Enquiry.find(
      { qualified: true },
      { name: 1, phone: 1, email: 1, source: 1, qualifiedAt: 1, "additionalInfo.instagramId": 1 }
    ).lean();

    const eligible = [];
    const skipReasons = new Map();
    for (const lead of qualified) {
      const origin = MetaCAPI.metaAdOrigin(lead);
      if (origin.eligible) eligible.push(lead);
      else {
        const key = origin.reason.replace(/"[^"]*"/, (m) => m); // keep the source in the key
        skipReasons.set(key, (skipReasons.get(key) || 0) + 1);
      }
    }

    say(`  qualified leads            ${qualified.length}`);
    say(`  PASS the Meta-ad gate      ${eligible.length}`);
    say(`  skipped                    ${qualified.length - eligible.length}`);
    if (skipReasons.size) {
      say("");
      say("  why they were skipped (the gate is loud by design):");
      for (const [reason, n] of [...skipReasons.entries()].sort((a, b) => b[1] - a[1])) {
        say(`    ${String(n).padStart(4)}  ${reason}`);
      }
    }

    // How many of the eligible ones could actually be identified to Meta.
    let sendable = 0;
    const noIdentifier = [];
    for (const lead of eligible) {
      const { identifiers } = MetaCAPI.buildEvent(lead);
      if (identifiers.length) sendable++;
      else noIdentifier.push(lead);
    }
    say("");
    say(`  of those, with a hashable identifier  ${sendable}`);
    if (noIdentifier.length) {
      say(`  with NO usable phone or email         ${noIdentifier.length}  <- these can never be sent`);
      for (const l of noIdentifier.slice(0, 5)) say(`      ${l._id}  ${l.name || "(no name)"}`);
    }

    // ── 2. The exact payload, for one lead ─────────────────────────────────
    rule("2. THE EXACT PAYLOAD");
    let subject = null;
    if (LEAD_ID) {
      subject = await Enquiry.findById(LEAD_ID).lean().catch(() => null);
      if (!subject) {
        err(`  lead ${LEAD_ID} not found.`);
        exitCode = 1;
      }
    } else {
      // Most recently qualified eligible lead — the one an operator is most
      // likely to be able to recognise and cross-check in Events Manager.
      subject = [...eligible]
        .filter((l) => MetaCAPI.buildEvent(l).identifiers.length)
        .sort((a, b) => new Date(b.qualifiedAt || 0) - new Date(a.qualifiedAt || 0))[0] || null;
      if (!subject) say("  no eligible lead with an identifier — nothing to preview.");
    }

    if (subject) {
      const origin = MetaCAPI.metaAdOrigin(subject);
      const { event, identifiers } = MetaCAPI.buildEvent(subject);

      say(`  lead        ${subject._id}`);
      say(`  name        ${subject.name || "(no name)"}`);
      say(`  source      ${JSON.stringify(subject.source)}`);
      say(`  qualifiedAt ${subject.qualifiedAt ? new Date(subject.qualifiedAt).toISOString() : "(unset — event_time falls back to now)"}`);
      say(`  gate        ${origin.eligible ? "PASSES" : "BLOCKED"} — ${origin.reason}`);
      say(`  identifiers ${identifiers.length ? identifiers.join(", ") : "NONE — this lead cannot be sent"}`);
      say("");

      const body = { data: [truncateHashes(event)] };
      if (process.env.META_CAPI_TEST_EVENT_CODE) body.test_event_code = process.env.META_CAPI_TEST_EVENT_CODE;
      say("  POST https://graph.facebook.com/" + MetaCAPI.API_VERSION +
          "/" + (process.env.META_CAPI_DATASET_ID || "{DATASET_ID}") + "/events?access_token=<redacted>");
      say("");
      say(JSON.stringify(body, null, 2).split("\n").map((l) => "  " + l).join("\n"));
      say("");
      say("  (em/ph shown as the first 8 characters only — a full SHA-256 of a");
      say("   phone number identifies a real person and is never printed here.)");

      // Cross-checks worth making explicit, because they are what a reviewer
      // would otherwise have to eyeball out of the JSON.
      const checks = [
        ["action_source is system_generated", event.action_source === "system_generated"],
        ["custom_data.event_source is crm", event.custom_data && event.custom_data.event_source === "crm"],
        ["event_time is unix SECONDS", Number.isInteger(event.event_time) && String(event.event_time).length === 10],
        ["event_time is not in the future", event.event_time <= Math.floor(Date.now() / 1000) + 60],
        ["event_id is stable for this lead", event.event_id === MetaCAPI.eventIdFor(subject._id)],
        ["no lead_id is sent", !("lead_id" in event) && !("lead_id" in (event.user_data || {}))],
        ["no unhashed contact detail in the payload", !JSON.stringify(event).includes(String(subject.phone || " "))],
      ];
      say("");
      for (const [label, pass] of checks) say(`  ${pass ? "OK  " : "BAD "} ${label}`);
      if (checks.some(([, p]) => !p)) exitCode = 1;

      // Meta drops events older than 7 days. Worth knowing BEFORE a confusing
      // events_received: 0 rather than after.
      const ageDays = (Date.now() / 1000 - event.event_time) / 86400;
      if (ageDays > 7) {
        say("");
        say(`  WARNING: this qualification is ${Math.floor(ageDays)} days old. Meta rejects events`);
        say("           older than 7 days, so a send would likely be dropped.");
      }
    }

    // ── 3. The send ────────────────────────────────────────────────────────
    if (!SEND) {
      rule("3. NOT SENDING");
      say("  DRY RUN — no request was made to Meta and nothing was written.");
      say("");
      say("  To send ONE lead as a TEST event:");
      say(`    node scripts/verify-meta-capi.js --send --lead ${subject ? subject._id : "<id>"}`);
      rule();
      await mongoose.disconnect();
      process.exit(exitCode);
    }

    rule("3. SENDING ONE LEAD (test event)");
    if (!subject) {
      err("  no lead to send.");
      await mongoose.disconnect();
      process.exit(1);
    }
    const origin = MetaCAPI.metaAdOrigin(subject);
    if (!origin.eligible) {
      err(`  REFUSING — lead ${subject._id} does not pass the gate: ${origin.reason}`);
      err("  The live code would skip it too. Sending it here would verify nothing");
      err("  and would report a lead to Meta that the product deliberately excludes.");
      await mongoose.disconnect();
      process.exit(2);
    }

    // ── Capture what Meta ACTUALLY returns ─────────────────────────────────
    // sendQualifiedLead() reports {sent, status} and swallows the body, so the
    // real response is teed here. The request is not altered or replayed: the
    // live function makes the one real call, and this reads a clone of the
    // answer. That is what makes this a verification of the deployed path
    // rather than of a copy of it.
    const realFetch = global.fetch;
    let wire = null;
    global.fetch = async (url, opts) => {
      const res = await realFetch(url, opts);
      try {
        const copy = res.clone();
        wire = { status: res.status, ok: res.ok, text: await copy.text() };
      } catch (e) {
        wire = { status: res.status, ok: res.ok, text: null, readError: e.message };
      }
      return res;
    };

    say(`  lead ${subject._id} — calling the live sendQualifiedLead()`);
    say(`  test_event_code ${process.env.META_CAPI_TEST_EVENT_CODE}`);
    say("");
    let result;
    try {
      result = await MetaCAPI.sendQualifiedLead(subject);
    } finally {
      global.fetch = realFetch;
    }

    rule("4. WHAT META RETURNED");
    if (!wire) {
      err("  NO HTTP REQUEST WAS MADE.");
      err(`  sendQualifiedLead() returned: ${JSON.stringify(result)}`);
      err("  The event was skipped before the network — see the reason above.");
      await mongoose.disconnect();
      process.exit(1);
    }

    let parsed = null;
    try { parsed = JSON.parse(wire.text); } catch { /* non-JSON body */ }

    say(`  HTTP status      ${wire.status}`);
    say(`  events_received  ${parsed && parsed.events_received !== undefined ? parsed.events_received : "(absent)"}`);
    say(`  fbtrace_id       ${(parsed && (parsed.fbtrace_id || (parsed.error && parsed.error.fbtrace_id))) || "(absent)"}`);
    const messages = parsed && parsed.messages;
    if (Array.isArray(messages) && messages.length) {
      say(`  messages[]       ${messages.length} warning(s):`);
      for (const m of messages) say(`      ${typeof m === "string" ? m : JSON.stringify(m)}`);
    } else {
      say(`  messages[]       ${Array.isArray(messages) ? "none" : "(absent)"}`);
    }
    if (parsed && parsed.error) {
      say("");
      say("  error:");
      say(JSON.stringify(parsed.error, null, 2).split("\n").map((l) => "    " + l).join("\n"));
    }
    say("");
    say("  raw body:");
    say(`    ${wire.text === null ? `(unreadable: ${wire.readError})` : wire.text.slice(0, 2000)}`);

    // ── The verdict, on the artifact ───────────────────────────────────────
    rule("5. VERDICT");
    const received = parsed && Number(parsed.events_received);
    if (!wire.ok) {
      err(`  FAILED — Meta answered HTTP ${wire.status}. The event was not accepted.`);
      exitCode = 1;
    } else if (!Number.isFinite(received)) {
      err("  FAILED — HTTP 2xx but the response carries no events_received.");
      err("  Meta did not confirm the event, so it is NOT verified as delivered.");
      exitCode = 1;
    } else if (received < 1) {
      err(`  FAILED — HTTP ${wire.status} with events_received: ${received}.`);
      err("  Meta accepted the request and DROPPED the event. A 2xx is not a");
      err("  delivery: check the payload above and any messages[] warnings.");
      exitCode = 1;
    } else {
      say(`  PASSED — Meta confirmed events_received: ${received}.`);
      say("");
      say("  Now confirm it in Events Manager → Test Events, matching:");
      say(`    event_id  ${MetaCAPI.eventIdFor(subject._id)}`);
      say("  An event confirmed here but absent there means the dataset id is");
      say("  pointing somewhere other than where you are looking.");
    }
    // Reported for completeness, and deliberately NOT used as the verdict.
    say("");
    say(`  (sendQualifiedLead() itself returned: ${JSON.stringify(result)} —`);
    say("   informational only; the verdict above is Meta's answer, not ours.)");
    rule();

    await mongoose.disconnect();
    process.exit(exitCode);
  } catch (e) {
    err("verification failed:", e && e.stack ? e.stack : String(e));
    if (connected) { try { await mongoose.disconnect(); } catch { /* already gone */ } }
    process.exit(1);
  }
})();
