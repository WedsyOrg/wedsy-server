/**
 * THE CONNECTED-ACCOUNT PANEL MUST TELL THE TRUTH.
 *
 * Production, 6 Sep 2026: both connectedinstagramaccounts rows are status
 * "revoked", and the panel still says @wedsy.in is connected.
 *
 * The cause is mine, from #173. The endpoint asks
 * fetchConnectedInstagramAccount(), which resolves its token through
 * resolveAccessToken() — and that falls back to
 * INSTAGRAM_AGENT_PAGE_ACCESS_TOKEN when no active row exists. The env token
 * still works, so Graph answers, so the endpoint reported connected: true. The
 * fallback was built to keep Kiara SENDING during one deploy; it was never
 * meant to be evidence that an account is connected.
 *
 * WHAT IT COSTS. Disconnect succeeds and the panel does not change, so a second
 * click 404s. And Connect never renders, so nobody can complete the OAuth round
 * trip Meta's recording needs. The product cannot get out of the state.
 *
 * THE FALLBACK IS A DEGRADED STATE, NOT A CONNECTION, and the payload now says
 * so as its own thing: `connected` means an active row exists and nothing else.
 *
 * Born red: with zero active rows and the env token present, the endpoint must
 * NOT report connected.
 *
 *   node tests/connected-account-truthful.test.js
 */
const Module = require("module");

let rows = [];
let liveProfile = null;
const origLoad = Module._load;
Module._load = function (r) {
  if (r.endsWith("/ConnectedInstagramAccount")) return {
    findOne: (f) => ({ sort: () => ({ lean: async () =>
      rows.find((x) => Object.entries(f).every(([k, v]) => x[k] === v)) || null }) }),
  };
  if (r.endsWith("/NotificationFailureLog")) return { create: async () => ({}) };
  if (r.endsWith("/utils/instagram")) return {
    // Stands in for the real helper, which resolves via the env fallback and so
    // answers even with no active row — the exact behaviour that misled the panel.
    fetchConnectedInstagramAccount: async () => liveProfile,
  };
  return origLoad.apply(this, arguments);
};

const { ConnectedAccount } = require("../controllers/instagramAgent");

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.error(`  ✗ ${l}`); } };
const eq = (g, w, l) => ok(g === w, `${l} (got ${JSON.stringify(g)})`);

const call = () => new Promise((resolve) => {
  const res = { status() { return this; }, json(b) { resolve(b); return this; } };
  ConnectedAccount({}, res);
});

const ACTIVE_ROW = { instagramUserId: "17841447723681883", username: "wedsy.in", status: "active" };
const LIVE = { id: "17841447723681883", username: "wedsy.in", profilePictureUrl: "https://cdn/x.jpg" };

const run = async () => {

console.log("\n1. THE PRODUCTION STATE — revoked rows, env token still working");
{
  rows = [{ ...ACTIVE_ROW, status: "revoked" }, { ...ACTIVE_ROW, instagramUserId: "179", status: "revoked" }];
  liveProfile = LIVE;                       // the env fallback still answers Graph
  const b = await call();
  eq(b.connected, false, "NOT connected — a revoked row is not a connection");
  eq(b.source, "env_fallback", "…the payload names what it is actually running on");
  eq(b.degraded, true, "…and says plainly that this is degraded");
}
{
  // The panel still needs to show WHOSE token is running, or an operator cannot
  // tell which account is about to be replaced.
  const b = await call();
  eq(b.username, "wedsy.in", "the fallback account's username is still reported");
  eq(b.id, "17841447723681883", "…and its id");
  ok(b.profilePictureUrl === "https://cdn/x.jpg", "…and its avatar");
}

console.log("\n2. A REAL CONNECTION IS STILL REPORTED AS ONE");
{
  rows = [ACTIVE_ROW];
  liveProfile = LIVE;
  const b = await call();
  eq(b.connected, true, "an ACTIVE row is connected");
  eq(b.source, "database", "…sourced from the database, not a token that happens to work");
  eq(b.degraded, false, "…and not degraded");
  eq(b.username, "wedsy.in", "…with the stored username");
}

console.log("\n3. NOTHING AT ALL");
{
  rows = [];
  liveProfile = null;
  const b = await call();
  eq(b.connected, false, "no row and no working token → not connected");
  eq(b.source, "none", "…source 'none'");
  eq(b.username, null, "…and nothing to show");
  eq(b.degraded, false, "…'degraded' is reserved for the fallback, not for nothing");
}

console.log("\n4. THE STATES ARE DISTINGUISHABLE — the panel can act on them");
{
  const seen = {};
  rows = [{ ...ACTIVE_ROW, status: "revoked" }]; liveProfile = LIVE;
  seen.fallback = await call();
  rows = [ACTIVE_ROW];                       seen.connected = await call();
  rows = []; liveProfile = null;             seen.none = await call();

  ok(new Set([seen.fallback.source, seen.connected.source, seen.none.source]).size === 3,
    "all three states report a distinct source");
  // The two that must not be confused: the whole bug was that these looked alike.
  ok(seen.fallback.connected === false && seen.connected.connected === true,
    "fallback and a real connection are no longer both 'connected'");
  // Connect must be offerable in BOTH non-connected states, or the product
  // cannot get out of the fallback — which is what is blocking Recording 1.
  ok(seen.fallback.connected === false && seen.none.connected === false,
    "Connect can be offered in both non-connected states");
}

console.log("\n5. THE CONTRACT SURVIVES: always 200, never a 500");
{
  rows = null;                               // force the read to throw
  liveProfile = LIVE;
  const b = await call();
  eq(b.connected, false, "an internal failure reports not-connected, not an error");
  eq(b.source, "none", "…and claims no source it cannot prove");
}

console.log("\n6. REGRESSION — the model can actually be created");
{
  // Found while verifying against the real code path: connectedByType had
  // enum ["admin","venueOwner","venueMember"] with default null, and mongoose
  // validates the default against the enum — so Model.create() threw on every
  // row that did not set the field. The live paths use findOneAndUpdate without
  // runValidators, so it sat unnoticed since the tenancy amendment.
  const realModel = origLoad.call(Module, "../models/ConnectedInstagramAccount", module, false);
  const doc = new realModel({
    instagramUserId: "t1", username: "t", accessToken: "t", tokenExpiresAt: new Date(),
  });
  const err = doc.validateSync();
  ok(!err, `a row with no connectedByType validates${err ? " — " + err.message : ""}`);
  ok(realModel.schema.path("connectedByType").enumValues.includes(null),
    "null is in the enum, matching WAConversation.classification");
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
};
run().catch((e) => { console.error("suite crashed:", e.message); process.exit(1); });
