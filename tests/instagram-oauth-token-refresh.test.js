/**
 * INSTAGRAM OAUTH CONNECT + LONG-LIVED TOKEN REFRESH.
 *
 * Two gaps this pins shut:
 *   1. there was no Instagram OAuth anywhere — the token was minted by hand;
 *   2. nothing refreshed it, so the inbox had a dated outage built in.
 *
 * The headline case is the TOKEN LEAK (section 1). The refresh call carries the
 * live token in the URL, so the house `NotificationFailureLog.create({ error })`
 * pattern would persist a working credential in plaintext on every failure.
 * These tests force real failures through the real code path and assert that
 * NOTHING resembling the token survives into the log row — checked as "no
 * 12-character window of the token appears anywhere in what was written",
 * which no accidental partial leak can slip past.
 *
 * PURE — models, Admin notifications and global.fetch are all stubbed, so there
 * is no Mongo, no network and no credentials. Every case drives the real
 * utils/instagram.js, utils/instagramTokenRefreshJob.js and
 * controllers/instagramOauth.js.
 *
 *   node tests/instagram-oauth-token-refresh.test.js
 */
process.env.INSTAGRAM_APP_ID = "1604457797522067";
process.env.INSTAGRAM_APP_SECRET = "0123456789abcdef0123456789abcdef";
process.env.INSTAGRAM_OAUTH_REDIRECT_URI = "https://prod.server.wedsy.in/instagram-agent/callback";
process.env.OS_APP_ORIGIN = "https://os.wedsy.in";
delete process.env.INSTAGRAM_AGENT_PAGE_ACCESS_TOKEN;

// A realistic long-lived IG token: the IGAA prefix and ~180 URL-safe chars.
const LIVE_TOKEN =
  "IGAAWqZBhbGxsBZAE9" + "aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uV3wX4yZ5" +
  "abcdefghijklmnopqrstuvwxyz0123456789_-" + "ZZa1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0";
const ROTATED_TOKEN =
  "IGAAWqZBhbGxsBZAE9" + "NEWNEWNEW1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6" +
  "p7q8r9s0t1u2v3w4x5y6z7A8B9C0D1E2F3G4H5I6" + "J7K8L9M0N1O2P3Q4R5S6T7U8V9W0X1Y2Z3";
const APP_SECRET = process.env.INSTAGRAM_APP_SECRET;

const Module = require("module");

// ── In-memory stand-ins for the four collections + the notification service ──
const db = { accounts: [], oauthStates: [], failureLogs: [], notifications: [] };
// Every stub appends its name here, so a test can assert not just WHAT ran but
// what ran BETWEEN two points — that is how the "persist immediately" contract
// is checked.
let trace = [];
const matches = (doc, filter) =>
  Object.entries(filter).every(([k, v]) => {
    const actual = k.includes(".") ? k.split(".").reduce((o, key) => (o == null ? o : o[key]), doc) : doc[k];
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("$gt" in v) return actual != null && new Date(actual) > new Date(v.$gt);
      if ("$ne" in v) return actual !== v.$ne;
      if ("$exists" in v) return (actual !== undefined) === v.$exists;
    }
    return actual === v;
  });
const chainable = (value) => {
  const c = { sort: () => c, select: () => c, lean: async () => value, then: (r) => Promise.resolve(value).then(r) };
  return c;
};

const ConnectedInstagramAccountStub = {
  findOne: (filter) => chainable(db.accounts.find((a) => matches(a, filter)) || null),
  find: async (filter) => db.accounts.filter((a) => matches(a, filter)),
  countDocuments: async (filter) => db.accounts.filter((a) => matches(a, filter)).length,
  updateOne: async (filter, update) => {
    trace.push("account.updateOne");
    const doc = db.accounts.find((a) => matches(a, filter));
    if (doc) Object.assign(doc, update.$set || {});
    return { modifiedCount: doc ? 1 : 0 };
  },
  findOneAndUpdate: async (filter, update, opts = {}) => {
    trace.push("account.findOneAndUpdate");
    let doc = db.accounts.find((a) => matches(a, filter));
    if (!doc && opts.upsert) {
      doc = { _id: `acct_${db.accounts.length + 1}`, ...filter, createdAt: new Date(), ...(update.$setOnInsert || {}) };
      db.accounts.push(doc);
    }
    if (doc) Object.assign(doc, update.$set || {}, { updatedAt: new Date() });
    return doc || null;
  },
};
const InstagramOAuthStateStub = {
  create: async (doc) => { const d = { ...doc, consumedAt: null, createdAt: new Date() }; db.oauthStates.push(d); return d; },
  findOneAndUpdate: async (filter, update) => {
    const doc = db.oauthStates.find((s) => matches(s, filter));
    if (!doc) return null;
    Object.assign(doc, update.$set || {});
    return doc;
  },
};
const NotificationFailureLogStub = {
  create: async (doc) => { trace.push("failureLog.create"); db.failureLogs.push({ ...doc }); return doc; },
  countDocuments: async (filter) => { trace.push("failureLog.countDocuments"); return db.failureLogs.filter((l) => matches(l, filter)).length; },
};
const AdminStub = { find: () => chainable([{ _id: "admin_owner_1" }]) };
const AdminNotificationServiceStub = {
  notify: async (ids, payload) => { trace.push("adminNotification.notify"); db.notifications.push({ ids, ...payload }); return []; },
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request.endsWith("/ConnectedInstagramAccount")) return ConnectedInstagramAccountStub;
  if (request.endsWith("/InstagramOAuthState")) return InstagramOAuthStateStub;
  if (request.endsWith("/NotificationFailureLog")) return NotificationFailureLogStub;
  if (request.endsWith("/models/Admin")) return AdminStub;
  if (request.endsWith("/AdminNotificationService")) return AdminNotificationServiceStub;
  return origLoad.apply(this, arguments);
};

// ── Scripted fetch ──────────────────────────────────────────────────────────
let fetchScript = [];
let fetchCalls = [];
global.fetch = async (url, opts) => {
  fetchCalls.push({ url: String(url), opts });
  const step = fetchScript.shift();
  if (!step) throw new Error("fetch stub ran off the end of the script");
  trace.push(step.trace || "fetch");
  if (step.networkError) {
    // Shaped like a real undici/axios failure: the full URL rides along in
    // .message, .config.url and .cause — every place the leak could come from.
    const err = new Error(`request to ${url} failed`);
    err.config = { url: String(url) };
    err.cause = { message: `connect ECONNREFUSED while calling ${url}` };
    throw err;
  }
  return {
    ok: step.status ? step.status < 400 : true,
    status: step.status || 200,
    text: async () => (typeof step.body === "string" ? step.body : JSON.stringify(step.body)),
  };
};

const ig = require("../utils/instagram");
const job = require("../utils/instagramTokenRefreshJob");
const oauth = require("../controllers/instagramOauth");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (got ${JSON.stringify(got)})`);
const reset = () => { db.accounts = []; db.oauthStates = []; db.failureLogs = []; db.notifications = []; trace = []; fetchScript = []; fetchCalls = []; };

// The leak assertion. Not "the exact token is absent" — that would pass on a
// truncated or re-encoded leak. Every 12-char window of the secret must be
// absent from every field of everything we persisted.
const CONTAINS_WINDOW = (haystack, secret, size = 12) => {
  for (let i = 0; i + size <= secret.length; i++) {
    if (haystack.includes(secret.slice(i, i + size))) return secret.slice(i, i + size);
  }
  return null;
};
const assertNoLeak = (haystack, secret, label) => {
  const found = CONTAINS_WINDOW(haystack, secret);
  ok(found === null, `${label}${found ? ` — LEAKED "${found}"` : ""}`);
};

const run = async () => {

console.log("\n1. TOKEN LEAK — a forced failure must persist no fragment of the credential");
{
  reset();
  db.accounts.push({
    _id: "acct_1", instagramUserId: "17841447723681883", username: "wedsy.in",
    accessToken: LIVE_TOKEN, tokenExpiresAt: new Date(Date.now() + 30 * 864e5),
    lastRefreshedAt: new Date(Date.now() - 10 * 864e5), createdAt: new Date(Date.now() - 60 * 864e5), status: "active",
  });
  // Three transport failures: initial attempt + 2 retries, then it gives up.
  fetchScript = [{ networkError: true }, { networkError: true }, { networkError: true }];
  await job.runInstagramTokenRefresh();

  ok(db.failureLogs.length === 1, `exactly one failure row written (got ${db.failureLogs.length})`);
  const persisted = JSON.stringify(db.failureLogs);
  assertNoLeak(persisted, LIVE_TOKEN, "persisted failure log contains no 12-char window of the live token");
  ok(persisted.includes("[redacted]"), "persisted failure log shows the redaction marker");
  eq(db.failureLogs[0].service, "Instagram", "log row service");
  eq(db.failureLogs[0].template, "token-refresh", "log row template");
  eq(db.failureLogs[0].attempts, 3, "log row records all attempts");
  eq(db.failureLogs[0].params && db.failureLogs[0].params.instagramUserId, "17841447723681883", "log row is tagged with the account");
  // Proof the raw error really did carry the token — i.e. the test is not
  // passing because the URL never contained it in the first place.
  ok(fetchCalls.some((c) => c.url.includes(LIVE_TOKEN)), "REGRESSION PROOF: the refresh URL genuinely carried the live token");
  assertNoLeak(JSON.stringify(db.notifications), LIVE_TOKEN, "admin notification payload contains no token window");
}
{
  // The app secret rides in the long-lived exchange query string.
  reset();
  fetchScript = [{ networkError: true }, { networkError: true }, { networkError: true }];
  try { await ig.exchangeForLongLivedToken("SHORTLIVED" + "x".repeat(40)); } catch (_) {}
  assertNoLeak(JSON.stringify(db.failureLogs), APP_SECRET, "long-lived exchange failure leaks no app-secret window");
  ok(fetchCalls[0].url.includes(APP_SECRET), "REGRESSION PROOF: the exchange URL genuinely carried the app secret");
}
{
  // A Meta 400 whose BODY quotes the token back at us.
  reset();
  fetchScript = [{ status: 400, body: { error: { message: `Invalid OAuth access token: ${LIVE_TOKEN}` } } }];
  try { await ig.refreshLongLivedToken(LIVE_TOKEN); } catch (_) {}
  assertNoLeak(JSON.stringify(db.failureLogs), LIVE_TOKEN, "a Meta error body quoting the token leaks nothing");
  eq(db.failureLogs[0].attempts, 1, "a 4xx is permanent — not retried");
}
{
  // Direct sanitiser unit checks, including a credential we never handed it.
  const unknown = "IGQVJXsomethingWeNeverConfigured0123456789abcdefghijKLMNOP";
  const msg = ig.sanitizeError(new Error(`GET https://graph.instagram.com/refresh_access_token?access_token=${unknown} failed`));
  assertNoLeak(msg, unknown, "shape rule redacts a token the sanitiser was never told about");
  ok(ig.redactSecrets("Instagram API error: 404").includes("404"), "ordinary status codes survive redaction");
}

{
  // ── TRUNCATION (regression, PR #188) ────────────────────────────────────
  // #188 began logging up to 300 chars of Meta's error body. Slicing a raw body
  // can CUT a token so that fewer than TOKEN_SHAPED's 32 characters survive:
  // the fragment then matches neither the exact-secret rule (not the whole
  // token) nor the shape rule (too short), and a leading fragment of a LIVE
  // token reached NotificationFailureLog and the console in plaintext.
  //
  // Two fixes, both pinned here: the call sites redact BEFORE truncating, and
  // redactSecrets now also catches fragments of a known secret. Either alone
  // would close the reported case; both together mean a future truncation
  // anywhere cannot reopen it.
  reset();
  process.env.INSTAGRAM_AGENT_PAGE_ACCESS_TOKEN = LIVE_TOKEN;

  // Every fragment length across the shape-rule boundary.
  for (const k of [8, 12, 16, 20, 24, 28, 31, 32, 40]) {
    const prefix = '{"error":{"message":"';
    const pad = 300 - prefix.length - 1 - k;
    const body = prefix + "x".repeat(pad) + " " + LIVE_TOKEN + '","type":"OAuthException"}}';
    const truncated = body.slice(0, 300);
    // Proof the input really is dangerous, so the assertion cannot pass vacuously.
    ok(CONTAINS_WINDOW(truncated, LIVE_TOKEN) !== null || k < 12,
      `  (k=${k}) raw truncated body genuinely carries a token fragment`);
    assertNoLeak(ig.redactSecrets(truncated, LIVE_TOKEN), LIVE_TOKEN,
      `truncated body with ${k} surviving token chars leaks nothing`);
  }

  // The diagnostics #188 exists to preserve must still come through.
  const diag = ig.redactSecrets('{"error":{"message":"(#10) Application does not have permission","code":10}}');
  ok(/does not have permission/.test(diag), "Meta's error text survives redaction (#188's purpose is intact)");
  ok(/"code":10/.test(diag), "…and its error code");
  delete process.env.INSTAGRAM_AGENT_PAGE_ACCESS_TOKEN;
}

console.log("\n2. AUTHORIZE URL — Instagram Login, not Facebook Login");
{
  reset();
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await oauth.Connect({ auth: { user_id: "admin_1" } }, res);
  const u = new URL(res.body.authorizeUrl);
  eq(u.origin + u.pathname, "https://www.instagram.com/oauth/authorize", "authorize endpoint");
  eq(u.searchParams.get("client_id"), "1604457797522067", "client_id is the Instagram app id");
  eq(u.searchParams.get("response_type"), "code", "response_type");
  eq(u.searchParams.get("scope"), "instagram_business_basic,instagram_business_manage_messages", "scopes");
  eq(u.searchParams.get("redirect_uri"), process.env.INSTAGRAM_OAUTH_REDIRECT_URI, "redirect_uri");
  ok((u.searchParams.get("state") || "").length >= 32, "state is long and random");
  assertNoLeak(res.body.authorizeUrl, APP_SECRET, "the authorize URL carries no app secret");
  eq(db.oauthStates.length, 1, "state persisted for the callback to verify");
  eq(db.oauthStates[0].adminId, "admin_1", "acting admin stamped on the state while still authed");
  eq(db.oauthStates[0].connectedByType, "admin", "…tagged as an admin");
  eq(db.oauthStates[0].venue, null, "…with venue null (Wedsy's own account)");
}
{
  // The guard on /connect is CheckAdminLogin today, but resolveActor already
  // reads the shapes middlewares/adminOrVenueOwnerAuth produces — so swapping
  // the guard later is one line, not a rewrite. These pin that contract.
  reset();
  const call = async (req) => {
    const res = { status() { return this; }, json(b) { this.body = b; return this; } };
    await oauth.Connect(req, res);
    return res.body;
  };
  await call({ admin: { _id: "admin_9", isAdmin: true } });
  eq(db.oauthStates[0].connectedByType, "admin", "adminOrVenueOwnerAuth admin shape (req.admin) → 'admin'");
  eq(db.oauthStates[0].venue, null, "…venue stays null");

  await call({ venueOwner: { type: "venue_owner", venueId: "venue_1", venueOwnerId: "owner_1" } });
  eq(db.oauthStates[1].connectedByType, "venueOwner", "venue OWNER token → 'venueOwner'");
  eq(db.oauthStates[1].adminId, "owner_1", "…actor id is the venue owner");
  eq(db.oauthStates[1].venue, "venue_1", "…venue carried from the JWT");

  await call({ venueOwner: { type: "venue_owner", venueId: "venue_2", memberId: "member_7" } });
  eq(db.oauthStates[2].connectedByType, "venueMember", "venue MEMBER token → 'venueMember'");
  eq(db.oauthStates[2].adminId, "member_7", "…actor id is the team member");
  eq(db.oauthStates[2].venue, "venue_2", "…venue carried from the JWT");
}

console.log("\n3. CALLBACK STATE — missing, unknown and reused are all rejected");
const callback = async (query) => {
  const res = { redirectedTo: null, redirect(u) { this.redirectedTo = u; return this; }, status() { return this; }, json() { return this; } };
  await oauth.Callback({ query }, res);
  return res.redirectedTo;
};
const okBody = () => ([
  { body: { access_token: "SHORT" + "y".repeat(40), user_id: "17841447723681883" } },
  { body: { access_token: ROTATED_TOKEN, token_type: "bearer", expires_in: 5184000 } },
  { body: { user_id: "17841447723681883", username: "wedsy.in", profile_picture_url: "https://cdn/x.jpg" } },
]);
{
  reset();
  ok((await callback({ code: "c" })).includes("instagram_connected=0&reason=invalid_state"), "missing state → rejected");
  ok((await callback({ code: "c", state: "never-issued" })).includes("reason=invalid_state"), "unknown state → rejected");
  ok((await callback({ state: "s" })).includes("reason=missing_code"), "missing code → rejected");
  ok((await callback({ state: "s", error: "access_denied" })).includes("reason=denied"), "user cancelled → clean 'denied'");
  eq(db.accounts.length, 0, "no account written by any rejected callback");
  ok(!(await callback({ code: "c", state: "x" })).includes("Error"), "no stack trace ever reaches the browser");
}
{
  reset();
  // Shaped exactly as /connect writes it (see section 2).
  db.oauthStates.push({ state: "good-state", adminId: "admin_1", connectedByType: "admin", venue: null, consumedAt: null, createdAt: new Date() });
  fetchScript = okBody();
  const first = await callback({ code: "auth-code", state: "good-state" });
  eq(first, "https://os.wedsy.in/instagram?instagram_connected=1", "happy path lands back in the inbox");
  eq(db.accounts.length, 1, "account row created");
  eq(db.accounts[0].instagramUserId, "17841447723681883", "keyed on the real IG user id");
  eq(db.accounts[0].accessToken, ROTATED_TOKEN, "the LONG-lived token is what gets stored");
  eq(db.accounts[0].connectedBy, "admin_1", "connectedBy read back off the state record");
  eq(db.accounts[0].connectedByType, "admin", "connectedByType read back off the state record");
  eq(db.accounts[0].venue, null, "venue null — Wedsy's own account");
  eq(db.accounts[0].status, "active", "row is active");
  const expiryDays = Math.round((db.accounts[0].tokenExpiresAt - Date.now()) / 864e5);
  ok(expiryDays === 60, `tokenExpiresAt = now + expires_in (${expiryDays} days)`);

  // REUSE: the same state a second time.
  fetchScript = okBody();
  const replay = await callback({ code: "auth-code", state: "good-state" });
  ok(replay.includes("reason=invalid_state"), "REUSED state → rejected (single-use consumed atomically)");
  eq(db.accounts.length, 1, "replay wrote nothing");
}
{
  // Multi-account: a second, different account must not displace the first.
  reset();
  db.oauthStates.push({ state: "s1", adminId: "admin_1", connectedByType: "admin", venue: null, consumedAt: null, createdAt: new Date() });
  db.oauthStates.push({ state: "s2", adminId: "admin_2", connectedByType: "admin", venue: null, consumedAt: null, createdAt: new Date() });
  fetchScript = okBody();
  await callback({ code: "c1", state: "s1" });
  fetchScript = [
    { body: { access_token: "SHORT2" + "y".repeat(40), user_id: "17999999999999999" } },
    { body: { access_token: ROTATED_TOKEN + "2", expires_in: 5184000 } },
    { body: { user_id: "17999999999999999", username: "venue.two", profile_picture_url: "" } },
  ];
  await callback({ code: "c2", state: "s2" });
  eq(db.accounts.length, 2, "two rows — the second account did not displace the first");
  eq(db.accounts[0].username, "wedsy.in", "first account intact");
  eq(db.accounts[1].username, "venue.two", "second account stored alongside");
}
{
  // Tenancy survives the unauthenticated hop: /callback has no token to read,
  // so venue + actor type can only come off the state record.
  reset();
  db.oauthStates.push({
    state: "venue-state", adminId: "owner_1", connectedByType: "venueOwner",
    venue: "venue_1", consumedAt: null, createdAt: new Date(),
  });
  fetchScript = okBody();
  await callback({ code: "c", state: "venue-state" });
  eq(db.accounts[0].venue, "venue_1", "venue reaches the account row through an UNAUTHENTICATED callback");
  eq(db.accounts[0].connectedByType, "venueOwner", "…and so does connectedByType");
  eq(db.accounts[0].connectedBy, "owner_1", "…and the non-Admin actor id (no hard ref)");
}

console.log("\n4. REFRESH JOB — rotation, the persist-immediately rule, and the 24h floor");
{
  reset();
  db.accounts.push({
    _id: "acct_1", instagramUserId: "17841447723681883", username: "wedsy.in", accessToken: LIVE_TOKEN,
    tokenExpiresAt: new Date(Date.now() + 20 * 864e5), lastRefreshedAt: new Date(Date.now() - 7 * 864e5),
    createdAt: new Date(Date.now() - 90 * 864e5), status: "active",
  });
  fetchScript = [{ body: { access_token: ROTATED_TOKEN, expires_in: 5184000 }, trace: "fetch:refresh" }];
  const summary = await job.runInstagramTokenRefresh();
  eq(summary.refreshed, 1, "one account rotated");
  eq(db.accounts[0].accessToken, ROTATED_TOKEN, "the NEW token was persisted (rotation, not reuse)");
  ok(db.accounts[0].lastRefreshedAt > new Date(Date.now() - 5000), "lastRefreshedAt moved");
  ok(Math.round((db.accounts[0].tokenExpiresAt - Date.now()) / 864e5) === 60, "expiry set from expires_in");

  // THE ORDERING RULE. Anything at all between receiving the rotated token and
  // writing it is a chance to throw and lose production's only credential.
  const i = trace.indexOf("fetch:refresh");
  const j = trace.indexOf("account.updateOne");
  ok(i >= 0 && j > i, "the write happens after the refresh");
  eq(trace.slice(i + 1, j).length, 0, `NOTHING runs between the refresh and the write (saw ${JSON.stringify(trace.slice(i + 1, j))})`);
}
{
  reset();
  db.accounts.push({
    _id: "acct_1", instagramUserId: "1784", username: "fresh", accessToken: LIVE_TOKEN,
    tokenExpiresAt: new Date(Date.now() + 60 * 864e5), lastRefreshedAt: new Date(Date.now() - 3600e3),
    createdAt: new Date(Date.now() - 3600e3), status: "active",
  });
  fetchScript = [];
  const summary = await job.runInstagramTokenRefresh();
  eq(summary.skipped, 1, "a token younger than 24h is skipped (Meta refuses it)");
  eq(fetchCalls.length, 0, "…and no call is made at all");
}
{
  reset();
  db.accounts.push({
    _id: "acct_1", instagramUserId: "1784", username: "revoked-one", accessToken: LIVE_TOKEN,
    tokenExpiresAt: new Date(), createdAt: new Date(Date.now() - 90 * 864e5), status: "revoked",
  });
  await job.runInstagramTokenRefresh();
  eq(fetchCalls.length, 0, "a revoked account is never refreshed");
}

console.log("\n5. ESCALATION — quiet on the first failure, loud on the second");
{
  reset();
  db.accounts.push({
    _id: "acct_1", instagramUserId: "17841447723681883", username: "wedsy.in", accessToken: LIVE_TOKEN,
    tokenExpiresAt: new Date(Date.now() + 40 * 864e5), lastRefreshedAt: new Date(Date.now() - 8 * 864e5),
    createdAt: new Date(Date.now() - 90 * 864e5), status: "active",
  });
  fetchScript = [{ networkError: true }, { networkError: true }, { networkError: true }];
  await job.runInstagramTokenRefresh();
  eq(db.notifications.length, 0, "first consecutive failure is quiet (a blip is not news)");
  eq(db.failureLogs.length, 1, "…but it is logged");

  fetchScript = [{ networkError: true }, { networkError: true }, { networkError: true }];
  await job.runInstagramTokenRefresh();
  eq(db.notifications.length, 1, "SECOND consecutive failure raises an AdminNotification");
  eq(db.notifications[0].type, "instagram_token_refresh_failed", "notification type");
  ok(db.notifications[0].message.includes("wedsy.in"), "notification names the account");
  assertNoLeak(JSON.stringify(db.notifications), LIVE_TOKEN, "the alert itself leaks no token window");

  // A success moves lastRefreshedAt, which is the watermark the count uses —
  // so the run resets rather than staying permanently loud.
  fetchScript = [{ body: { access_token: ROTATED_TOKEN, expires_in: 5184000 } }];
  await job.runInstagramTokenRefresh();
  const after = await job.countFailuresSinceLastSuccess(db.accounts[0]);
  eq(after, 0, "a successful refresh resets the consecutive-failure count");
}

console.log("\n6. TOKEN SOURCE — the model, with .env as a one-deploy bootstrap only");
{
  reset();
  process.env.INSTAGRAM_AGENT_PAGE_ACCESS_TOKEN = "ENV_BOOTSTRAP_TOKEN_0123456789";
  eq(await ig.resolveAccessToken(), "ENV_BOOTSTRAP_TOKEN_0123456789", "no active row → falls back to .env (production keeps sending)");
  db.accounts.push({ _id: "a", instagramUserId: "1", username: "wedsy.in", accessToken: LIVE_TOKEN, status: "active", updatedAt: new Date() });
  eq(await ig.resolveAccessToken(), LIVE_TOKEN, "an active row WINS over .env");
  db.accounts[0].status = "revoked";
  eq(await ig.resolveAccessToken(), "ENV_BOOTSTRAP_TOKEN_0123456789", "a revoked row is not used");
  delete process.env.INSTAGRAM_AGENT_PAGE_ACCESS_TOKEN;
  eq(await ig.resolveAccessToken(), null, "neither → null (no call, no log spam)");
}
{
  // SCOPE GUARD. The venue field is shape only for now: resolution stays
  // single-active-account and must NOT start filtering by tenant. If someone
  // adds a selector later this assertion is the thing that should be changed
  // deliberately, rather than the behaviour drifting under the inbox.
  reset();
  db.accounts.push({ _id: "a", instagramUserId: "1", username: "venue.one", accessToken: LIVE_TOKEN, status: "active", venue: "venue_1", updatedAt: new Date() });
  eq(await ig.resolveAccessToken(), LIVE_TOKEN, "resolution is tenant-BLIND today — a venue-owned row still resolves");
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
};

run().catch((e) => { console.error("suite crashed:", e); process.exit(1); });
