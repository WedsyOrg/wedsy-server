/**
 * PERMISSION REFUSALS MUST NOT BE RETRIED, AND MUST NOT OFFER A RETRY.
 *
 * Production (pm2, 2026-09-04):
 *   [Instagram] human-agent DM failed after 3 attempts: Instagram API error:
 *   403 {"error":{"message":"To use 'Human Agent', your use of this endpoint
 *   must be reviewed and approved by Facebook. ...","type":"IGApiException"}}
 *
 * Two defects in how the refusal is HANDLED (the send itself is correct):
 *   1. three outbound attempts against a 403 that cannot change between them;
 *   2. the client is told to try again, when trying again cannot work.
 *
 * This suite is the gate. It is written BEFORE the fix and is expected to fail.
 *
 *   node tests/ig-permission-no-retry.test.js
 */
process.env.INSTAGRAM_AGENT_PAGE_ACCESS_TOKEN =
  "IGAAWqZBhbGxsBZAE9aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uV3wX4yZ5abcdefghij";
const TOKEN = process.env.INSTAGRAM_AGENT_PAGE_ACCESS_TOKEN;

const Module = require("module");
const logs = [];
const conversations = {};
const origLoad = Module._load;
Module._load = function (r) {
  if (r.endsWith("/ConnectedInstagramAccount")) return { findOne: () => ({ sort: () => ({ lean: async () => null }) }) };
  if (r.endsWith("/NotificationFailureLog")) return { create: async (d) => { logs.push(d); return d; } };
  if (r.endsWith("/repositories/WAConversationRepository")) return {
    findById: async (id) => conversations[id] || null,
    touchOutbound: async (id) => ({ toObject: () => ({ ...conversations[id] }) }),
    updateFieldsById: async (id, f) => { Object.assign(conversations[id], f); return { toObject: () => ({ ...conversations[id] }) }; },
  };
  if (r.endsWith("/repositories/EnquiryRepository")) return { stampFirstRespondedAt: async () => {}, touchLastActivity: async () => {} };
  if (r.endsWith("/LeadInternalEventService")) return { record: async () => {} };
  if (r.endsWith("/models/WAAgentMessage")) return function (d) { this.doc = d; this.save = async () => ({ ...d, populate: async () => {} }); };
  if (r.endsWith("/models/Enquiry")) return { findOne: () => ({ lean: async () => ({ _id: "l" }) }) };
  if (r.endsWith("/utils/whatsapp")) return { sendWhatsAppText: async () => ({ ok: true }) };
  return origLoad.apply(this, arguments);
};
const realErr = console.error; console.error = () => {};

// Meta's actual 403 shape. The numeric code is NOT asserted anywhere: the full
// body could not be retrieved from EC2 (ssh is permission-gated), so matching is
// on `type` + HTTP status only until a complete body is available.
const HUMAN_AGENT_403 = JSON.stringify({
  error: {
    message: "To use 'Human Agent', your use of this endpoint must be reviewed and approved by Facebook.",
    type: "IGApiException",
  },
});

let calls = 0, nextStatus = 200, nextBody = "{}", nextHeaders = {};
const waits = [];
global.fetch = async () => {
  calls++;
  return {
    ok: nextStatus < 400,
    status: nextStatus,
    headers: { get: (h) => nextHeaders[String(h).toLowerCase()] ?? null },
    text: async () => nextBody,
    json: async () => JSON.parse(nextBody || "{}"),
  };
};
// Capture backoff without actually sleeping.
const realTimeout = global.setTimeout;
global.setTimeout = (fn, ms) => { waits.push(ms); return realTimeout(fn, 0); };

const ig = require("../utils/instagram");
const svc = require("../services/WAConversationService");

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; realErr(`  ✓ ${l}`); } else { fail++; realErr(`  ✗ ${l}`); } };
const eq = (g, w, l) => ok(g === w, `${l} (got ${JSON.stringify(g)})`);
const arm = (status, body = '{"error":{"message":"boom","type":"X"}}', headers = {}) => {
  calls = 0; waits.length = 0; logs.length = 0;
  nextStatus = status; nextBody = body; nextHeaders = headers;
};
const oid = (n) => String(n).padStart(24, "a");
const mkConv = (n, over) => {
  const id = oid(n);
  conversations[id] = { _id: id, phone: "ig_user", channel: "instagram", mode: "human",
    lastInboundAt: new Date(Date.now() - 30 * 3600e3), enquiryId: "l", ...over };
  return id;
};
const sendVia = async (n) => {
  try { await svc.sendText(oid(n), "hi", "admin1", {}); return { ok: true }; }
  catch (e) { return { ok: false, status: e.status, message: e.message, err: e }; }
};

const run = async () => {

realErr("\n1. GATE — a 403 permission refusal makes EXACTLY ONE attempt");
{
  arm(403, HUMAN_AGENT_403);
  await ig.sendInstagramHumanAgentDM("r", "m").catch(() => {});
  eq(calls, 1, "human-agent 403 → exactly 1 outbound attempt");
  eq(waits.filter((w) => w >= 1000).length, 0, "…and no backoff sleep");
}
{
  arm(403, HUMAN_AGENT_403);
  await ig.sendInstagramDM("r", "m");
  eq(calls, 1, "AUTOMATED path 403 → exactly 1 attempt (same defect, same fix)");
  arm(401);
  await ig.sendInstagramDM("r", "m");
  eq(calls, 1, "automated 401 → 1 attempt");
  arm(400);
  await ig.sendInstagramDM("r", "m");
  eq(calls, 1, "automated 400 (malformed) → 1 attempt");
}

realErr("\n2. GATE — the client is told it cannot retry, and why");
{
  arm(403, HUMAN_AGENT_403);
  mkConv(1);
  const r = await sendVia(1);
  eq(r.ok, false, "sendText surfaces the refusal as an error");
  // Guard against a vacuous pass: undefined === undefined would otherwise be
  // "green" while neither the constant nor the flag exists.
  ok(typeof ig.HUMAN_AGENT_NOT_APPROVED === "string" && ig.HUMAN_AGENT_NOT_APPROVED.length > 0,
    "the named constant is exported (not undefined)");
  eq(r.err && r.err.code, ig.HUMAN_AGENT_NOT_APPROVED, "…carrying the named constant, not matched English");
  eq(r.err && r.err.retryable, false, "…explicitly NOT retryable (no retry affordance)");
  ok(/approv/i.test(r.message || ""), "…and the message names the approval requirement");
  eq(r.err && r.err.instagramPermissionRequired, true, "…flagged as a permission gap, not a send failure");

  // The refusal must not carry Meta's raw body to the client.
  const blob = JSON.stringify(r.err) + (r.message || "");
  ok(!blob.includes(TOKEN.slice(0, 12)), "…and leaks no token fragment to the client");
}

realErr("\n3. RETRY ASYMMETRY — Kiara retries, a human send does not");
// WHY THESE TWO DIFFER, because a future reader will want to "harmonise" them.
//
// A retry is a BLIND RE-POST: nothing tells "Meta never saw this" apart from
// "Meta delivered it and we lost the receipt". Measured, a transport failure
// after delivery sends up to THREE identical DMs while WAAgentMessage records
// one row — the customer sees three, the transcript shows one.
//
//   Kiara: retries stay. A dropped automated reply means a lead is never
//   answered and nobody notices. A duplicate is the lesser harm.
//   Human:  one attempt, every class. A person is sitting there and can press
//   send again knowingly — better than us pressing it for them and maybe
//   sending a salesperson's message to a lead three times.
//
// These assertions MUST flip back together once the send path has an
// idempotency key. Until then, asserting 3 on the human path would make this
// suite defend the duplicate-delivery defect.
{
  arm(500);
  await ig.sendInstagramDM("r", "m");
  eq(calls, 3, "AUTOMATED 500 → 3 attempts (Kiara: a dropped reply is worse than a duplicate)");
}
{
  arm(500);
  await ig.sendInstagramHumanAgentDM("r", "m").catch(() => {});
  eq(calls, 1, "HUMAN 500 → exactly 1 attempt (no blind re-POST of a person's message)");
  eq(waits.filter((w) => w >= 1000).length, 0, "…and no backoff sleep");
}
{
  // NO STATUS AT ALL — timeout / ECONNRESET / DNS. The class a numeric rule hides.
  calls = 0; waits.length = 0;
  global.fetch = async () => { calls++; throw Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }); };
  await ig.sendInstagramDM("r", "m");
  eq(calls, 3, "AUTOMATED transport failure (no status) → RETRYABLE, 3 attempts");
  // The exact case that duplicates: Meta may have delivered before the socket
  // dropped. On the human path we refuse to guess.
  calls = 0;
  await ig.sendInstagramHumanAgentDM("r", "m").catch(() => {});
  eq(calls, 1, "HUMAN transport failure → exactly 1 attempt (it may already have been delivered)");
  global.fetch = async () => {
    calls++;
    return { ok: nextStatus < 400, status: nextStatus,
      headers: { get: (h) => nextHeaders[String(h).toLowerCase()] ?? null },
      text: async () => nextBody, json: async () => JSON.parse(nextBody || "{}") };
  };
}

realErr("\n4. GATE — 429 retries WITH Meta's backoff, not faster");
{
  arm(429, '{"error":{"message":"rate limited"}}', { "retry-after": "7" });
  await ig.sendInstagramDM("r", "m");
  eq(calls, 3, "AUTOMATED 429 → retried");
  ok(waits.some((w) => w === 7000), `…honouring Retry-After: 7s (waits seen: ${JSON.stringify(waits)})`);
}
{
  arm(429, '{"error":{"message":"rate limited"}}');   // no header
  await ig.sendInstagramDM("r", "m");
  ok(waits.some((w) => w === 2000), "429 with no Retry-After → falls back to the default backoff");
}
{
  arm(429, '{"error":{"message":"rate limited"}}', { "retry-after": "7" });
  await ig.sendInstagramHumanAgentDM("r", "m").catch(() => {});
  eq(calls, 1, "HUMAN 429 → 1 attempt (the person decides whether to wait and resend)");
}

realErr("\n5. GATE — the classifier is TOTAL (no hidden members)");
{
  const c = typeof ig.classifyFailure === "function" ? ig.classifyFailure : () => "(not implemented)";
  ok(typeof ig.classifyFailure === "function", "classifyFailure is exported");
  for (const s of [400, 401, 403, 404]) eq(c(s), "permanent", `status ${s} → permanent`);
  for (const s of [408, 429, 500, 502, 503, 504]) eq(c(s), "retryable", `status ${s} → retryable`);
  eq(c(undefined), "retryable", "NO STATUS (transport) → retryable — stated, not defaulted by accident");
  eq(c(null), "retryable", "null status → retryable");
  eq(c(0), "retryable", "status 0 (aborted) → retryable");
  eq(c(418), "permanent", "unlisted 4xx → permanent (will not fix itself)");
  eq(c(599), "retryable", "unlisted 5xx → retryable");
}

realErr(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
};
run().catch((e) => { realErr("suite crashed:", e.message); process.exit(1); });
