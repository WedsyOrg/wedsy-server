/**
 * READ-ONLY GUARD + DISCONNECT SCOPE.
 *
 * The safety layer that must exist BEFORE any reviewer account does. Two of
 * these three are production-critical well beyond that one account:
 *
 *   1. A read-only account cannot write ANYTHING. Not via the 100 delete routes
 *      that carry no permission to gate against, not via settings, not via a
 *      POST anywhere. Method-level, at the auth choke-point.
 *   2. Disconnect cannot touch the live @wedsy.in row. Ownership by default,
 *      overridden only by a full-scope permission grant — never by an id.
 *   3. `leads:view:own` is what keeps real client conversations away from the
 *      reviewer, so the scope resolution itself is pinned.
 *
 * PURE — models and the permission lookup are stubbed. No Mongo, no network.
 *
 *   node tests/readonly-guard-disconnect-scope.test.js
 */
const Module = require("module");

const db = { accounts: [], admins: {}, roles: {} };
const origLoad = Module._load;
Module._load = function (request) {
  if (request.endsWith("/ConnectedInstagramAccount")) return ConnectedStub;
  if (request.endsWith("/InstagramOAuthState")) return { create: async (d) => d, findOneAndUpdate: async () => null };
  if (request.endsWith("/NotificationFailureLog")) return { create: async () => ({}) };
  if (request.endsWith("/repositories/AdminRepository")) return AdminRepoStub;
  if (request.endsWith("/repositories/RoleRepository")) return RoleRepoStub;
  return origLoad.apply(this, arguments);
};
const ConnectedStub = {
  findOne: (f) => ({ lean: async () => db.accounts.find((a) => match(a, f)) || null }),
  countDocuments: async (f) => db.accounts.filter((a) => match(a, f)).length,
  findOneAndUpdate: async (f, u) => {
    const d = db.accounts.find((a) => match(a, f));
    if (!d) return null;
    Object.assign(d, u.$set || {});
    return d;
  },
};
const match = (doc, f) =>
  Object.entries(f).every(([k, v]) => (k === "_id" ? String(doc._id) === String(v) : String(doc[k]) === String(v)));
const AdminRepoStub = { findById: async (id) => db.admins[String(id)] || null };
const RoleRepoStub = { findByIds: async (ids) => ids.map((i) => db.roles[String(i)]).filter(Boolean) };

const { enforceReadOnly, READONLY_PERMISSION } = require("../middlewares/enforceReadOnly");
const oauth = require("../controllers/instagramOauth");

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.error(`  ✗ ${l}`); } };
const eq = (g, w, l) => ok(g === w, `${l} (got ${JSON.stringify(g)})`);

// Build an admin carrying the given permissions.
let seq = 0;
const mkAdmin = (perms) => {
  const rid = `role_${++seq}`, aid = `admin_${seq}`;
  db.roles[rid] = { _id: rid, permissions: perms };
  db.admins[aid] = { _id: aid, roleIds: [rid] };
  return db.admins[aid];
};

// Run enforceReadOnly and report allow/deny.
const tryWrite = (admin, method, url = "/enquiry") =>
  new Promise((resolve) => {
    const req = { method, originalUrl: url, auth: { user_id: admin._id, user: admin } };
    const res = { status(c) { this.code = c; return this; }, json(b) { resolve({ allowed: false, code: this.code, body: b }); } };
    enforceReadOnly(req, res, () => resolve({ allowed: true }));
  });

const run = async () => {

console.log("\n1. READ-ONLY GUARD — the reviewer cannot write, anywhere");
{
  const reviewer = mkAdmin(["leads:view:own", READONLY_PERMISSION]);

  for (const m of ["GET", "HEAD", "OPTIONS"]) {
    eq((await tryWrite(reviewer, m)).allowed, true, `${m} is allowed (reading is the whole job)`);
  }
  // The 100 ungated delete routes are the reason this is method-level.
  for (const [m, url] of [
    ["DELETE", "/enquiry"],                    // lead delete — CheckAdminLogin ONLY
    ["DELETE", "/settings/themes/1"],
    ["DELETE", "/coupon/1"],
    ["POST", "/wa/conversations/1/send"],      // messaging a real client
    ["POST", "/admin"],                        // user management
    ["PUT", "/role/1"],                        // permissions
    ["PATCH", "/settings/themes/1"],
    ["PUT", "/settings"],
    ["POST", "/settlements/transfer"],         // money
  ]) {
    const r = await tryWrite(reviewer, m, url);
    eq(r.allowed, false, `${m} ${url} is BLOCKED`);
    eq(r.code, 403, `  …with 403`);
  }
}
{
  // The guard must be invisible to everyone else — this ships to production.
  const founder = mkAdmin(["*:*:all"]);
  const sales = mkAdmin(["leads:view:own", "leads:edit:own"]);
  const noPerms = mkAdmin([]);
  eq((await tryWrite(founder, "DELETE")).allowed, true, "FOUNDER can still delete — wildcard must NOT match the marker");
  eq((await tryWrite(founder, "POST", "/admin")).allowed, true, "…and can still manage users");
  eq((await tryWrite(sales, "POST", "/wa/conversations/1/send")).allowed, true, "a normal sales admin is unaffected");
  eq((await tryWrite(noPerms, "DELETE")).allowed, true, "a zero-permission admin is unaffected (opt-IN, not opt-out)");
}
{
  // Fail closed: if the permission lookup throws, a write must not slip through.
  const broken = { _id: "broken", roleIds: ["missing_role"] };
  db.admins.broken = broken;
  const orig = RoleRepoStub.findByIds;
  RoleRepoStub.findByIds = async () => { throw new Error("db down"); };
  const r = await tryWrite(broken, "DELETE");
  RoleRepoStub.findByIds = orig;
  eq(r.allowed, false, "a lookup FAILURE blocks the write (fail closed)");
  eq(r.code, 403, "  …with 403");
}

console.log("\n2. DISCONNECT — the live @wedsy.in row must be unreachable by the reviewer");
{
  const post = (admin, body) =>
    new Promise((resolve) => {
      const res = { status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code || 200, body: b }); } };
      oauth.Disconnect({ body, auth: { user_id: admin._id, user: admin } }, res).catch((e) => resolve({ code: 500, body: String(e) }));
    });

  const reviewer = mkAdmin(["leads:view:own", READONLY_PERMISSION]);
  const founder = mkAdmin(["*:*:all"]);
  const otherAdmin = mkAdmin(["leads:view:team", "leads:edit:team"]);

  // The real row: seeded by script, so connectedBy is null.
  db.accounts = [{ _id: "live", instagramUserId: "17841447723681883", username: "wedsy.in", status: "active", connectedBy: null }];

  let r = await post(reviewer, { instagramUserId: "17841447723681883" });
  eq(r.code, 403, "REVIEWER cannot disconnect the live @wedsy.in row");
  eq(db.accounts[0].status, "active", "  …the connection is untouched");

  r = await post(otherAdmin, { instagramUserId: "17841447723681883" });
  eq(r.code, 403, "another scoped admin cannot either (connectedBy is null — owned by nobody)");
  eq(db.accounts[0].status, "active", "  …still untouched");

  // The override that unblocks the screencast.
  r = await post(founder, { instagramUserId: "17841447723681883" });
  eq(r.code, 200, "FOUNDER can disconnect it — the full-scope grant, so the flow can be filmed");
  eq(db.accounts[0].status, "revoked", "  …row revoked");
}
{
  const post = (admin, body) =>
    new Promise((resolve) => {
      const res = { status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code || 200, body: b }); } };
      oauth.Disconnect({ body, auth: { user_id: admin._id, user: admin } }, res).catch((e) => resolve({ code: 500, body: String(e) }));
    });
  const owner = mkAdmin(["leads:view:own"]);
  const stranger = mkAdmin(["leads:view:own"]);

  // Ownership: you may revoke what you connected.
  db.accounts = [{ _id: "mine", instagramUserId: "1799", username: "venue.two", status: "active", connectedBy: owner._id }];
  let r = await post(stranger, { instagramUserId: "1799" });
  eq(r.code, 403, "a stranger cannot disconnect someone else's account");
  ok(/only disconnect an Instagram account that you connected/i.test(r.body.message || ""), "  …and is told why, not given a misleading 404");

  r = await post(owner, { instagramUserId: "1799" });
  eq(r.code, 200, "the CONNECTOR can disconnect their own account");
  eq(db.accounts[0].status, "revoked", "  …row revoked");
}
{
  const post = (admin, body) =>
    new Promise((resolve) => {
      const res = { status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code || 200, body: b }); } };
      oauth.Disconnect({ body, auth: { user_id: admin._id, user: admin } }, res).catch((e) => resolve({ code: 500, body: String(e) }));
    });
  const founder = mkAdmin(["*:*:all"]);
  db.accounts = [];
  const r = await post(founder, { instagramUserId: "does-not-exist" });
  eq(r.code, 404, "a genuinely missing row is still a 404, not a 403");
}

console.log("\n3. SCOPE SEMANTICS — what a leads:view:own role can and cannot reach");
{
  const { permissionSatisfies, buildScopeFilter } = require("../middlewares/requirePermission");
  const reviewerPerms = ["leads:view:own", READONLY_PERMISSION];

  ok(permissionSatisfies(reviewerPerms, "leads:view:own").allowed, "reviewer may VIEW leads at own scope");
  ok(!permissionSatisfies(reviewerPerms, "leads:edit:own").allowed,
    "reviewer may NOT edit — this is what blocks sending a DM to a real client");
  ok(!permissionSatisfies(reviewerPerms, "leads:view:all").allowed, "reviewer cannot widen to ALL leads");
  ok(!permissionSatisfies(reviewerPerms, "users:create:all").allowed, "no user management");
  ok(!permissionSatisfies(reviewerPerms, "roles:edit:all").allowed, "no role editing");
  ok(!permissionSatisfies(reviewerPerms, "settings:edit:all").allowed, "no app settings");

  // The filter that does the actual hiding.
  const filter = await buildScopeFilter("own", { _id: "reviewer_id" }, "assignedTo");
  eq(JSON.stringify(filter), JSON.stringify({ assignedTo: "reviewer_id" }),
    "own scope resolves to { assignedTo: reviewer } — seeded leads only, real clients invisible");

  // And the marker is not a capability anyone can inherit.
  ok(!permissionSatisfies(["leads:view:own"], READONLY_PERMISSION).allowed,
    "the readonly marker is not implied by ordinary grants");
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
};

run().catch((e) => { console.error("suite crashed:", e); process.exit(1); });
