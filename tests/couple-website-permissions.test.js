// COUPLE APP § 06.4 — EVERY REFUSAL PATH ON THE WEBSITE ENDPOINTS.
// Run: node tests/couple-website-permissions.test.js
//
// PURE unit tests (NO DATABASE). Like tests/couple-people-permissions.test.js
// these run the REAL middlewares — the ones routes/coupleApp-website.js mounts
// — against a fabricated `req.couple`, because the gate that matters is the one
// on the route and not a copy of it in a test.
//
// Two halves, and they are different in kind:
//
//   THE COUPLE'S SIX are gated `website / view` or `website / edit`. A shared
//   family member with `website: "view"` may look at the builder and may not
//   save a word of it; one with `website: "none"` is refused all six; an
//   invitation that was never opened and a membership that was revoked are
//   refused before any section is consulted.
//
//   THE PUBLIC THREE have no gate at all, and this file asserts that ON
//   PURPOSE — by reading the route table and checking that CoupleAuth is
//   mounted on every couple route and on none of the public ones. A public
//   route that accidentally grew a gate would 401 every guest; a couple route
//   that lost one would be a section the client's UI is the only thing hiding,
//   which § 06.4 says is not a control.
const { RequireSection, CoupleAuth } = require("../middlewares/coupleAuth");
const websiteRoutes = require("../routes/coupleApp-website");
const permissions = require("../services/CouplePermissions");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${JSON.stringify(got)} vs ${JSON.stringify(want)})`);

/** Minimal express stand-ins — the same shape tests/couple-people-permissions.test.js uses. */
const run = (middleware, { params = {}, headers = {}, query = {}, couple } = {}) =>
  new Promise((resolve) => {
    let statusCode = 200, payload = null, nexted = false;
    const req = { params, headers, query, couple };
    const res = {
      status(c) { statusCode = c; return this; },
      send(p) { payload = p; resolve({ statusCode, payload, nexted, req }); return this; },
      json(p) { return this.send(p); },
      setHeader() { return this; },
    };
    Promise.resolve(middleware(req, res, () => { nexted = true; resolve({ statusCode, payload, nexted, req }); }));
  });

const ME = "6512f0aa11bb22cc33dd44ee";
const partner = { userId: ME, weddingId: "w", role: "partner", member: null };
const member = (access, extra = {}) => ({
  userId: ME, weddingId: "w", role: "member",
  member: { _id: "m1", name: "Sunita", acceptedAt: new Date(), revokedAt: null, access, ...extra },
});
const ALL_EDIT = { guests: "edit", website: "edit", decor: "edit", registry: "edit", payments: "edit", tasks: "edit" };
const NOTHING = { guests: "none", website: "none", decor: "none", registry: "none", payments: "none", tasks: "none" };
const VIEW_ONLY = { ...NOTHING, website: "view" };
const EVERYTHING_BUT_WEBSITE = { ...ALL_EDIT, website: "none" };

/** The gates exactly as routes/coupleApp-website.js mounts them. */
const READS = [
  ["GET  /wedding/:id/website", RequireSection("website", "view")],
  ["GET  /wedding/:id/website/slug/check", RequireSection("website", "view")],
];
const WRITES = [
  ["PUT  /wedding/:id/website", RequireSection("website", "edit")],
  ["PUT  /wedding/:id/website/content", RequireSection("website", "edit")],
  ["POST /wedding/:id/website/photos", RequireSection("website", "edit")],
  ["POST /wedding/:id/website/publish", RequireSection("website", "edit")],
];
const ALL = [...READS, ...WRITES];

(async () => {
  console.log("Both partners pass every website endpoint:");
  for (const [name, gate] of ALL) {
    const r = await run(gate, { couple: partner });
    ok(r.nexted, `${name} — a partner passes`);
  }

  console.log("A member with website: none is refused all six:");
  for (const [name, gate] of ALL) {
    const r = await run(gate, { couple: member(NOTHING) });
    eq(r.statusCode, 403, `${name} — refused`);
    eq(r.payload.error, "forbidden", `${name} — the foundation's refusal shape`);
    eq(r.payload.section, "website", `${name} — names the section`);
    eq(r.payload.held, "none", `${name} — and what they actually hold`);
    ok(typeof r.payload.message === "string" && r.payload.message.length > 0, `${name} — with something renderable`);
  }

  console.log("A member with EVERY OTHER SECTION at edit is still refused the website:");
  for (const [name, gate] of ALL) {
    const r = await run(gate, { couple: member(EVERYTHING_BUT_WEBSITE) });
    eq(r.statusCode, 403, `${name} — refused, however much else they hold`);
    eq(r.payload.section, "website", `${name} — the refusal is about this section alone`);
  }

  console.log("A member with website: view may LOOK and may not SAVE:");
  {
    for (const [name, gate] of READS) {
      const r = await run(gate, { couple: member(VIEW_ONLY) });
      ok(r.nexted, `${name} — passes on view`);
    }
    for (const [name, gate] of WRITES) {
      const r = await run(gate, { couple: member(VIEW_ONLY) });
      eq(r.statusCode, 403, `${name} — refused on view`);
      eq(r.payload.required, "edit", `${name} — names the level it wanted`);
      eq(r.payload.held, "view", `${name} — and the level they hold`);
    }
  }

  console.log("A member with website: edit passes all six — and nothing more:");
  {
    for (const [name, gate] of ALL) {
      const r = await run(gate, { couple: member({ ...NOTHING, website: "edit" }) });
      ok(r.nexted, `${name} — passes on edit`);
    }
    // The website section grants the website. It is not a back door to money.
    const money = await run(RequireSection("payments", "view"), { couple: member({ ...NOTHING, website: "edit" }) });
    eq(money.statusCode, 403, "and payments is still shut to them");
    eq(permissions.canInitiatePayout(member({ ...NOTHING, website: "edit" })), false, "and they can never initiate a payout");
  }

  console.log("An invitation that was never opened is not access:");
  for (const [name, gate] of ALL) {
    const r = await run(gate, { couple: member(ALL_EDIT, { acceptedAt: null }) });
    eq(r.statusCode, 403, `${name} — refused although the access map says edit`);
  }

  console.log("A revoked member is refused immediately:");
  for (const [name, gate] of ALL) {
    const r = await run(gate, { couple: member(ALL_EDIT, { revokedAt: new Date() }) });
    eq(r.statusCode, 403, `${name} — refused on their very next request`);
  }

  console.log("Fail closed on anything unrecognised:");
  {
    const junk = [
      ["an access map that is missing entirely", member(undefined)],
      ["an access map that is a string", member("edit")],
      ["a level outside the enum", member({ ...NOTHING, website: "owner" })],
      ["a level that is a boolean", member({ ...NOTHING, website: true })],
      ["a member row that is null", { userId: ME, weddingId: "w", role: "member", member: null }],
    ];
    for (const [label, couple] of junk) {
      const r = await run(RequireSection("website", "view"), { couple });
      eq(r.statusCode, 403, `${label} — resolves to none, not to access`);
    }
  }

  console.log("No req.couple at all is a 401, not a 403 — the client sends them to sign in:");
  {
    const r = await run(RequireSection("website", "view"), { couple: undefined });
    eq(r.statusCode, 401, "401");
    eq(r.payload.error, "unauthenticated", "with the shape lib/plan/api.js reads");
  }

  console.log("THE ROUTE TABLE ITSELF — the gates are on the couple's routes and off the guests':");
  {
    const layers = (router) => (router.stack || [])
      .filter((layer) => layer.route)
      .map((layer) => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods).join(",").toUpperCase(),
        names: (layer.route.stack || []).map((handler) => handler.handle),
      }));

    const coupleRoutes = layers(websiteRoutes);
    eq(coupleRoutes.length, 6, "six couple-facing routes are mounted");
    coupleRoutes.forEach((route) => {
      ok(route.names.indexOf(CoupleAuth) !== -1, `${route.methods} ${route.path} — mounts the REAL CoupleAuth`);
      // The section gate is a closure, so it is identified by there being a
      // middleware between CoupleAuth and the handler.
      ok(route.names.length >= 3, `${route.methods} ${route.path} — and a gate between it and the handler`);
      ok(route.names[0] === CoupleAuth, `${route.methods} ${route.path} — with auth FIRST, before anything reads the wedding`);
    });

    const publicRoutes = layers(websiteRoutes.itemRoutes);
    eq(publicRoutes.length, 3, "three public routes are mounted");
    const paths = publicRoutes.map((r) => `${r.methods} ${r.path}`).sort();
    eq(paths.join(" | "), "GET /site/:slug | POST /site/:slug/rsvp | POST /site/:slug/unlock",
      "and they are exactly the three the guest contract names");
    publicRoutes.forEach((route) => {
      ok(route.names.indexOf(CoupleAuth) === -1, `${route.methods} ${route.path} — carries NO CoupleAuth: a guest has no token`);
      // A limiter and a handler: § 06.4's "rate-limit both public POSTs", and
      // the read as well.
      eq(route.names.length, 2, `${route.methods} ${route.path} — a rate limiter and the handler, in that order`);
    });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
