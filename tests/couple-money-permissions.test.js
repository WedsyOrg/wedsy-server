// COUPLE APP § 06.4 — EVERY REFUSAL PATH ON THE MONEY ENDPOINTS.
// Run: node tests/couple-money-permissions.test.js
//
// PURE unit tests (NO DATABASE). These run the REAL middlewares — the ones
// routes/coupleApp-money.js actually mounts — against a fabricated `req.couple`,
// because the gate that matters is the one on the route and not a copy of it in
// a test.
//
// THE ONE THAT MATTERS MOST (§ 06.4): "`edit` on payments never implies the
// ability to initiate a payout." A shared family member with ALL SIX SECTIONS
// AT EDIT may reschedule and annotate a payment, and may not pay it, and may
// not move a rupee of gift money to a bank. That is asserted below not as a
// check somebody remembered to write, but as a structural fact: there is no
// value in a SharedMember document that could satisfy RequirePayout.
const { RequireSection, RequirePayout } = require("../middlewares/coupleAuth");
const permissions = require("../services/CouplePermissions");
const moneyRoutes = require("../routes/coupleApp-money");
const { SECTION, ACCESS_LEVEL } = require("../utils/coupleEnums");

const { RequireEvery } = moneyRoutes;

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${JSON.stringify(got)} vs ${JSON.stringify(want)})`);

/** Minimal express stand-ins — the same shape tests/couple-people-permissions.test.js uses. */
const run = (middleware, couple) =>
  new Promise((resolve) => {
    let statusCode = 200, payload = null, nexted = false;
    const req = { params: {}, headers: {}, couple };
    const res = {
      status(c) { statusCode = c; return this; },
      send(p) { payload = p; resolve({ statusCode, payload, nexted }); return this; },
      json(p) { return this.send(p); },
    };
    Promise.resolve(middleware(req, res, () => { nexted = true; resolve({ statusCode, payload, nexted }); }));
  });

const ME = "6512f0aa11bb22cc33dd44ee";
const partner = { userId: ME, weddingId: "w", role: "partner", member: null };
const member = (access, extra = {}) => ({
  userId: ME, weddingId: "w", role: "member",
  member: { _id: "m1", name: "Sunita", acceptedAt: new Date(), revokedAt: null, access, ...extra },
});
const ALL_EDIT = { guests: "edit", website: "edit", decor: "edit", registry: "edit", payments: "edit", tasks: "edit" };
const ALL_VIEW = { guests: "view", website: "view", decor: "view", registry: "view", payments: "view", tasks: "view" };
const NOTHING = { guests: "none", website: "none", decor: "none", registry: "none", payments: "none", tasks: "none" };

const WALLET_GATE = RequireEvery([["registry", "view"], ["payments", "view"]]);

/** The gates exactly as routes/coupleApp-money.js mounts them. */
const SECTION_GATES = [
  ["GET    /wedding/:id/registry",            RequireSection("registry", "view"), "registry", "view"],
  ["PATCH  /wedding/:id/registry",            RequireSection("registry", "edit"), "registry", "edit"],
  ["POST   /wedding/:id/registry/fetch-link", RequireSection("registry", "edit"), "registry", "edit"],
  ["POST   /wedding/:id/registry/items",      RequireSection("registry", "edit"), "registry", "edit"],
  ["POST   /wedding/:id/registry/funds",      RequireSection("registry", "edit"), "registry", "edit"],
  ["PATCH  /registry-items/:id",              RequireSection("registry", "edit"), "registry", "edit"],
  ["DELETE /registry-items/:id",              RequireSection("registry", "edit"), "registry", "edit"],
  ["PATCH  /registry-funds/:id",              RequireSection("registry", "edit"), "registry", "edit"],
  ["DELETE /registry-funds/:id",              RequireSection("registry", "edit"), "registry", "edit"],
  ["PATCH  /contributions/:id",               RequireSection("registry", "edit"), "registry", "edit"],
  ["GET    /wedding/:id/payments",            RequireSection("payments", "view"), "payments", "view"],
];

/** The two that move money OUT. Never a section gate. */
const PAYOUT_GATES = [
  ["POST /wedding/:id/wallet/claim", RequirePayout],
  ["POST /payments/:id/pay",         RequirePayout],
];

(async () => {
  console.log("Both partners pass every money endpoint, including the payouts:");
  for (const [name, gate] of SECTION_GATES) {
    ok((await run(gate, partner)).nexted, `${name} — partner passes`);
  }
  ok((await run(WALLET_GATE, partner)).nexted, "GET    /wedding/:id/wallet — partner passes");
  for (const [name, gate] of PAYOUT_GATES) {
    ok((await run(gate, partner)).nexted, `${name} — partner passes`);
  }

  console.log("\nTHE PAYOUT GATE — a member with EVERYTHING at edit still cannot move money:");
  for (const [name, gate] of PAYOUT_GATES) {
    const res = await run(gate, member(ALL_EDIT));
    eq(res.nexted, false, `${name} — refused`);
    eq(res.statusCode, 403, `${name} — 403`);
    eq(res.payload.error, "forbidden_payout", `${name} — with its OWN code, so the screen can word it properly`);
    ok(String(res.payload.message || "").length > 0, `${name} — and something to render`);
  }
  {
    // Structural, not a check: there is no key to set, and no argument to pass.
    eq(SECTION.indexOf("payouts"), -1, "\"payouts\" is not one of the six grantable sections");
    eq(SECTION.length, 6, "and there are exactly six");
    eq(permissions.canInitiatePayout.length, 1, "canInitiatePayout takes ONE argument — there is no access map in its signature");
    eq(permissions.canInitiatePayout(member(ALL_EDIT)), false, "so no access map can satisfy it");
    eq(permissions.canInitiatePayout(partner), true, "and being one of the two people getting married is the only thing that does");

    // Try to invent a seventh key. It has nowhere to go.
    const overreach = member({ ...ALL_EDIT, payouts: "edit", payout: "edit", wallet: "edit" });
    eq(permissions.canInitiatePayout(overreach), false, "a fabricated `payouts: \"edit\"` key changes nothing");
    eq((await run(RequirePayout, overreach)).statusCode, 403, "and the gate still refuses");
  }

  console.log("\nEvery section gate, at every level a member can hold:");
  for (const [name, gate, section, needed] of SECTION_GATES) {
    for (const held of ACCESS_LEVEL) {
      const res = await run(gate, member({ ...NOTHING, [section]: held }));
      const shouldPass = ACCESS_LEVEL.indexOf(held) >= ACCESS_LEVEL.indexOf(needed);
      eq(res.nexted, shouldPass, `${name} — held "${held}", needs "${needed}"`);
      if (!shouldPass) {
        eq(res.statusCode, 403, `${name} — refused with 403`);
        eq(res.payload.error, "forbidden", `${name} — error: forbidden`);
        eq(res.payload.section, section, `${name} — naming the section, so the screen can say which door`);
        eq(res.payload.required, needed, `${name} — and the level it needed`);
        eq(res.payload.held, held, `${name} — and the level they hold`);
      }
    }
  }

  console.log("\nA member with a section at `view` is refused every registry WRITE:");
  {
    const viewer = member(ALL_VIEW);
    ok((await run(RequireSection("registry", "view"), viewer)).nexted, "they may read the registry");
    for (const [name, gate, , needed] of SECTION_GATES) {
      if (needed !== "edit") continue;
      eq((await run(gate, viewer)).nexted, false, `${name} — refused`);
    }
    eq((await run(RequirePayout, viewer)).statusCode, 403, "and they certainly may not pay");
  }

  console.log("\nThe wallet needs BOTH sections (docs/couple-app-api.md § 5):");
  {
    eq((await run(WALLET_GATE, member({ ...NOTHING, registry: "view", payments: "view" }))).nexted, true, "registry AND payments at view — passes");
    const noPayments = await run(WALLET_GATE, member({ ...NOTHING, registry: "edit" }));
    eq(noPayments.nexted, false, "registry alone — refused");
    eq(noPayments.payload.section, "payments", "and told which section is short");
    const noRegistry = await run(WALLET_GATE, member({ ...NOTHING, payments: "edit" }));
    eq(noRegistry.nexted, false, "payments alone — refused");
    eq(noRegistry.payload.section, "registry", "and told which section is short");
    eq((await run(WALLET_GATE, member(NOTHING))).statusCode, 403, "neither — refused");
    eq((await run(WALLET_GATE, member(ALL_EDIT))).nexted, true, "both at edit — passes, edit outranks view");
  }

  console.log("\nAn invitation never opened, and one taken away:");
  {
    // resolveMembership refuses these before a gate is ever reached; asserted
    // here at the permission layer so the refusal cannot move without notice.
    const pending = { _id: "m2", name: "Sunita", acceptedAt: null, revokedAt: null, access: ALL_EDIT };
    const revoked = { _id: "m3", name: "Sunita", acceptedAt: new Date(), revokedAt: new Date(), access: ALL_EDIT };
    eq(permissions.isActiveMember(pending), false, "an invitation that was never opened is not access");
    eq(permissions.isActiveMember(revoked), false, "and one that was revoked is not access, immediately");
    eq(permissions.isActiveMember(null), false, "and no row at all is certainly not");

    const stale = { userId: ME, weddingId: "w", role: "member", member: revoked };
    eq((await run(RequireSection("registry", "view"), stale)).nexted, false, "a revoked member reads nothing");
    eq((await run(RequirePayout, stale)).nexted, false, "and pays nothing");
  }

  console.log("\nFail closed, everywhere:");
  {
    eq((await run(RequireSection("registry", "view"), undefined)).statusCode, 401, "no req.couple at all is a 401, not a pass");
    eq((await run(RequirePayout, undefined)).statusCode, 401, "the payout gate too");
    eq((await run(WALLET_GATE, undefined)).statusCode, 401, "and the wallet gate");
    eq((await run(RequireSection("registry", "view"), member({}))).nexted, false, "an EMPTY access map grants nothing");
    eq((await run(RequireSection("registry", "view"), member({ registry: "owner" }))).nexted, false, "a level outside the enum grants nothing");
    eq((await run(RequireSection("nonsense", "view"), member(ALL_EDIT))).nexted, false, "an unknown SECTION grants nothing, even to a member with everything");
    eq(permissions.levelFor(member(ALL_EDIT), "payouts"), "none", "and 'payouts' reads as none, because it is not a section");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
