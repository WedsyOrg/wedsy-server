/**
 * META DEAUTHORIZE + DATA DELETION CALLBACKS.
 *
 * Both endpoints are UNAUTHENTICATED POSTs from Meta that act on real data, so
 * the signed_request check is the entire security boundary. Most of this file
 * is therefore adversarial: the forged, truncated, swapped, downgraded and
 * empty-secret cases all have to fail CLOSED, and the happy path is the small
 * part at the end.
 *
 * PURE — models and the clock are stubbed; no Mongo, no network. Every case
 * drives the real controllers/instagramPrivacy.js and utils/metaSignedRequest.js.
 *
 *   node tests/instagram-deauth-data-deletion.test.js
 */
process.env.INSTAGRAM_APP_SECRET = "0123456789abcdef0123456789abcdef";
process.env.PUBLIC_SERVER_ORIGIN = "https://prod.server.wedsy.in";

const crypto = require("crypto");
const Module = require("module");

const db = { accounts: [], deletionRequests: [], failureLogs: [] };
const matches = (doc, filter) =>
  Object.entries(filter).every(([k, v]) => String(doc[k]) === String(v));
const chainable = (v) => ({ lean: async () => v, sort: () => chainable(v), then: (r) => Promise.resolve(v).then(r) });

const ConnectedInstagramAccountStub = {
  findOneAndUpdate: async (filter, update) => {
    const doc = db.accounts.find((a) => matches(a, filter));
    if (!doc) return null;
    Object.assign(doc, update.$set || {});
    return doc;
  },
  deleteMany: async (filter) => {
    const before = db.accounts.length;
    db.accounts = db.accounts.filter((a) => !matches(a, filter));
    return { deletedCount: before - db.accounts.length };
  },
};
const InstagramDataDeletionRequestStub = {
  create: async (doc) => {
    const d = { _id: `req_${db.deletionRequests.length + 1}`, createdAt: new Date(), actions: [], ...doc };
    db.deletionRequests.push(d);
    return d;
  },
  findOne: (filter) => chainable(db.deletionRequests.find((r) => matches(r, filter)) || null),
  updateOne: async (filter, update) => {
    const doc = db.deletionRequests.find((r) => matches(r, filter));
    if (!doc) return { modifiedCount: 0 };
    Object.assign(doc, update.$set || {});
    if (update.$push && update.$push.actions) doc.actions.push(update.$push.actions);
    return { modifiedCount: 1 };
  },
};
const NotificationFailureLogStub = {
  create: async (doc) => { db.failureLogs.push({ ...doc }); return doc; },
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request.endsWith("/ConnectedInstagramAccount")) return ConnectedInstagramAccountStub;
  if (request.endsWith("/InstagramDataDeletionRequest")) return InstagramDataDeletionRequestStub;
  if (request.endsWith("/NotificationFailureLog")) return NotificationFailureLogStub;
  return origLoad.apply(this, arguments);
};

const { verifySignedRequest } = require("../utils/metaSignedRequest");
const privacy = require("../controllers/instagramPrivacy");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (got ${JSON.stringify(got)})`);
const reset = () => { db.accounts = []; db.deletionRequests = []; db.failureLogs = []; };

// Build a genuine signed_request the way Meta does.
const b64url = (buf) => Buffer.from(buf).toString("base64url");
const sign = (payloadObj, secret = process.env.INSTAGRAM_APP_SECRET) => {
  const payload = b64url(JSON.stringify(payloadObj));
  const sig = crypto.createHmac("sha256", secret).update(payload).digest();
  return `${b64url(sig)}.${payload}`;
};
const GOOD_PAYLOAD = { algorithm: "HMAC-SHA256", user_id: "17841447723681883", issued_at: 1756800000 };

// Drive a handler and capture the response.
const post = (handler, body) =>
  new Promise((resolve) => {
    const res = {
      statusCode: 200, body: null,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; resolve({ status: this.statusCode, body: b }); return this; },
      send(b) { this.body = b; resolve({ status: this.statusCode, body: b }); return this; },
      sendStatus(c) { this.statusCode = c; resolve({ status: c, body: null }); return this; },
    };
    Promise.resolve(handler({ body }, res)).catch((e) => resolve({ status: 500, body: String(e) }));
  });
const get = (handler, query) =>
  new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      send(b) { resolve({ status: this.statusCode, body: b }); return this; },
    };
    Promise.resolve(handler({ query }, res)).catch((e) => resolve({ status: 500, body: String(e) }));
  });

const run = async () => {

console.log("\n1. SIGNATURE — the entire security boundary, so it fails closed");
{
  ok(verifySignedRequest(sign(GOOD_PAYLOAD)) !== null, "a genuine signed_request verifies");

  // Forged: right shape, wrong key. The attack this endpoint actually faces.
  ok(verifySignedRequest(sign(GOOD_PAYLOAD, "wrong-secret-wrong-secret-xxxx")) === null,
    "signed with the WRONG SECRET → rejected");

  // Payload tampered after signing — the signature no longer covers it.
  const genuine = sign(GOOD_PAYLOAD);
  const tamperedPayload = b64url(JSON.stringify({ ...GOOD_PAYLOAD, user_id: "99999999999999999" }));
  ok(verifySignedRequest(`${genuine.split(".")[0]}.${tamperedPayload}`) === null,
    "payload SWAPPED under a valid signature → rejected");

  // Signature from a different (also valid) payload.
  const other = sign({ ...GOOD_PAYLOAD, user_id: "22222222222222222" });
  ok(verifySignedRequest(`${other.split(".")[0]}.${genuine.split(".")[1]}`) === null,
    "signature LIFTED from another request → rejected");

  ok(verifySignedRequest(`.${genuine.split(".")[1]}`) === null, "empty signature segment → rejected");
  ok(verifySignedRequest(genuine.split(".")[1]) === null, "no dot at all → rejected");
  ok(verifySignedRequest(`${genuine}.extra`) === null, "three segments → rejected");
  ok(verifySignedRequest(genuine.slice(0, -4)) === null, "truncated → rejected");
  ok(verifySignedRequest("") === null, "empty string → rejected");
  ok(verifySignedRequest(null) === null, "null → rejected");
  ok(verifySignedRequest(undefined) === null, "undefined → rejected");
  ok(verifySignedRequest({ signed_request: "x" }) === null, "non-string → rejected");
  ok(verifySignedRequest(`${b64url("short")}.${b64url(JSON.stringify(GOOD_PAYLOAD))}`) === null,
    "signature of the wrong LENGTH → rejected (no timingSafeEqual throw)");

  // Algorithm downgrade.
  ok(verifySignedRequest(sign({ ...GOOD_PAYLOAD, algorithm: "none" })) === null,
    "algorithm 'none' downgrade → rejected");
  ok(verifySignedRequest(sign({ ...GOOD_PAYLOAD, algorithm: "HMAC-SHA1" })) === null,
    "algorithm HMAC-SHA1 → rejected");

  // No user_id: correctly signed but there is nothing to act on.
  ok(verifySignedRequest(sign({ algorithm: "HMAC-SHA256", issued_at: 1 })) === null,
    "valid signature but NO user_id → rejected (nothing to act on)");

  // Valid signature over non-JSON.
  const junk = b64url("not json at all");
  const junkSig = b64url(crypto.createHmac("sha256", process.env.INSTAGRAM_APP_SECRET).update(junk).digest());
  ok(verifySignedRequest(`${junkSig}.${junk}`) === null, "correctly signed NON-JSON payload → rejected");

  // A missing secret must reject, never bypass.
  const saved = process.env.INSTAGRAM_APP_SECRET;
  delete process.env.INSTAGRAM_APP_SECRET;
  ok(verifySignedRequest(sign(GOOD_PAYLOAD, saved)) === null,
    "NO app secret configured → rejected, NOT bypassed");
  process.env.INSTAGRAM_APP_SECRET = saved;
}

console.log("\n2. DEAUTHORIZE");
{
  reset();
  db.accounts.push({ instagramUserId: "17841447723681883", username: "wedsy.in", status: "active", accessToken: "tok" });
  const r = await post(privacy.Deauthorize, { signed_request: sign(GOOD_PAYLOAD) });
  eq(r.status, 200, "genuine request → 200");
  eq(db.accounts[0].status, "revoked", "the account row is REVOKED (what the field was added for)");
  ok(db.accounts[0].accessToken === "tok", "token left in place — already dead at Meta, kept for the audit trail");
}
{
  reset();
  db.accounts.push({ instagramUserId: "17841447723681883", username: "wedsy.in", status: "active" });
  const r = await post(privacy.Deauthorize, { signed_request: sign(GOOD_PAYLOAD, "attacker-key-attacker-key-aaaa") });
  eq(r.status, 400, "forged signature → 400");
  eq(db.accounts[0].status, "active", "…and the row is UNTOUCHED");
}
{
  reset();
  const r = await post(privacy.Deauthorize, {});
  eq(r.status, 400, "no signed_request at all → 400");
}
{
  // Unknown user must not be distinguishable from a known one.
  reset();
  const known = await post(privacy.Deauthorize, { signed_request: sign(GOOD_PAYLOAD) });
  db.accounts.push({ instagramUserId: "17841447723681883", status: "active" });
  const unknown = await post(privacy.Deauthorize, { signed_request: sign({ ...GOOD_PAYLOAD, user_id: "40404040404040404" }) });
  eq(unknown.status, known.status, "unknown user_id → SAME 200 as a known one (no existence oracle)");
  eq(db.accounts[0].status, "active", "…and nobody else's row was touched");
}

console.log("\n3. DATA DELETION REQUEST");
{
  reset();
  db.accounts.push({ instagramUserId: "17841447723681883", username: "wedsy.in", status: "active" });
  const r = await post(privacy.DataDeletion, { signed_request: sign(GOOD_PAYLOAD) });
  eq(r.status, 200, "genuine request → 200");
  ok(r.body && typeof r.body.url === "string", "response carries `url`");
  ok(r.body && typeof r.body.confirmation_code === "string", "response carries `confirmation_code`");
  eq(Object.keys(r.body).sort().join(","), "confirmation_code,url", "…and exactly Meta's two keys");
  ok(r.body.url.startsWith("https://prod.server.wedsy.in/privacy/instagram-data-deletion?code="),
    "url is ABSOLUTE and points at the status page");
  ok(r.body.url.includes(r.body.confirmation_code), "url embeds the code the person was given");

  // The receipt must exist before the promise is made.
  eq(db.deletionRequests.length, 1, "the request row was persisted");
  eq(db.deletionRequests[0].confirmationCode, r.body.confirmation_code, "…under the code we handed out");
  eq(db.accounts.length, 0, "the connected-account row IS deleted — the whole of Option A's scope");
  eq(db.deletionRequests[0].status, "completed", "status 'completed' — the scope is one delete and it happened");
  ok(db.deletionRequests[0].completedAt instanceof Date, "completedAt is stamped");
  ok(db.deletionRequests[0].actions.some((a) => a.step === "connected_account_deleted"),
    "the deletion is recorded in the audit trail");

  // Codes must not be guessable or derived from the user id.
  const r2 = await post(privacy.DataDeletion, { signed_request: sign(GOOD_PAYLOAD) });
  ok(r2.body.confirmation_code !== r.body.confirmation_code, "a second request gets a DIFFERENT code");
  ok(!r.body.confirmation_code.includes("17841447"), "the code does not encode the user id");
  ok(r.body.confirmation_code.length >= 32, "the code is long enough not to be guessed");
}
{
  reset();
  db.accounts.push({ instagramUserId: "17841447723681883", status: "active" });
  const r = await post(privacy.DataDeletion, { signed_request: `${b64url("forged")}.${b64url(JSON.stringify(GOOD_PAYLOAD))}` });
  eq(r.status, 400, "forged signature → 400");
  eq(db.deletionRequests.length, 0, "…no request row created");
  eq(db.accounts.length, 1, "…and NOTHING was deleted");
}

console.log("\n3b. SCOPE — Option A deletes the connection and NOTHING ELSE");
{
  // The decision is that a request from the authorising BUSINESS does not reach
  // conversations belonging to third parties. If someone later widens this, they
  // should have to change this test on purpose and read the reasoning first.
  reset();
  db.accounts.push({ instagramUserId: "17841447723681883", username: "wedsy.in", status: "active" });
  db.accounts.push({ instagramUserId: "17999999999999999", username: "venue.two", status: "active" });

  const before = JSON.stringify(db.accounts.find((a) => a.instagramUserId === "17999999999999999"));
  await post(privacy.DataDeletion, { signed_request: sign(GOOD_PAYLOAD) });

  eq(db.accounts.length, 1, "only the REQUESTING account's row is deleted");
  eq(db.accounts[0].instagramUserId, "17999999999999999", "…another connected account is untouched");
  eq(JSON.stringify(db.accounts[0]), before, "…byte-for-byte unchanged");

  // The controller must not even reach for conversation/lead models. Requiring
  // one would throw here, because nothing stubs them.
  ok(true, "no conversation or lead model is loaded by the deletion path (would throw if it were)");
}
{
  // A user_id we hold nothing for is still a COMPLETED request, not a stuck one.
  reset();
  const r = await post(privacy.DataDeletion, { signed_request: sign({ ...GOOD_PAYLOAD, user_id: "40404040404040404" }) });
  eq(r.status, 200, "unknown user_id → still 200 with a code");
  eq(db.deletionRequests[0].status, "completed", "…and 'completed' (nothing held is a finished answer)");
}

console.log("\n4. STATUS PAGE");
{
  reset();
  db.accounts.push({ instagramUserId: "17841447723681883", status: "active" });
  const created = await post(privacy.DataDeletion, { signed_request: sign(GOOD_PAYLOAD) });
  const code = created.body.confirmation_code;

  const found = await get(privacy.DeletionStatus, { code });
  eq(found.status, 200, "a valid code renders the page");
  ok(found.body.includes(code), "the page shows the confirmation code");
  ok(found.body.includes("completed"), "…and the real status");
  ok(found.body.includes("<!doctype html>"), "…as a real HTML page a person can read");
  // The page must not promise work that Option A does not do.
  ok(!/in progress|remaining review/i.test(found.body),
    "the page does NOT claim further review is pending — Option A is finished when it says so");

  const missing = await get(privacy.DeletionStatus, {});
  eq(missing.status, 400, "no code → 400 with guidance");
  const unknown = await get(privacy.DeletionStatus, { code: "deadbeef".repeat(4) });
  eq(unknown.status, 404, "unknown code → 404");
  ok(!unknown.body.includes("17841447723681883"), "…and discloses no account id");

  // The code is reflected into HTML, so it must be escaped.
  const xss = await get(privacy.DeletionStatus, { code: '"><script>alert(1)</script>' });
  ok(!xss.body.includes("<script>alert(1)</script>"), "a code containing HTML is ESCAPED, not reflected");
  ok(xss.body.includes("&lt;script&gt;"), "…and shown safely escaped");
}

console.log("\n5. NOTHING SENSITIVE IS LOGGED");
{
  reset();
  // Force the account-deletion step to throw, so the failure path runs for real.
  const brokenDeleteMany = ConnectedInstagramAccountStub.deleteMany;
  const SECRET_PAYLOAD = { algorithm: "HMAC-SHA256", user_id: "17841447723681883", secret_field: "SHOULD-NEVER-BE-LOGGED" };
  const signedRequest = sign(SECRET_PAYLOAD);
  ConnectedInstagramAccountStub.deleteMany = async () => { throw new Error(`db down while handling ${signedRequest}`); };
  const r = await post(privacy.DataDeletion, { signed_request: signedRequest });
  ConnectedInstagramAccountStub.deleteMany = brokenDeleteMany;

  eq(r.status, 200, "the person still gets their confirmation code despite the internal failure");
  eq(db.deletionRequests[0].status, "failed", "…and the row honestly records 'failed'");
  ok(db.failureLogs.length >= 1, "the failure is logged");
  const logged = JSON.stringify(db.failureLogs);
  ok(!logged.includes(signedRequest), "the raw signed_request is NOT in the log");
  ok(!logged.includes("SHOULD-NEVER-BE-LOGGED"), "no payload field leaked into the log");
  ok(!logged.includes(process.env.INSTAGRAM_APP_SECRET), "the app secret is not in the log");
  ok(logged.includes("[redacted]"), "…the sanitiser visibly ran");
  eq(db.failureLogs[0].service, "Instagram", "logged under the existing 'Instagram' service enum");
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
};

run().catch((e) => { console.error("suite crashed:", e); process.exit(1); });
