// COUPLE APP § 06.4 — EVERY REFUSAL PATH ON THE PLANNING ENDPOINTS.
// Run: node tests/couple-planning-permissions.test.js
//
// PURE unit tests (NO DATABASE). These run the REAL middlewares — the ones
// routes/coupleApp-planning.js actually mounts — against a fabricated
// `req.couple`, because the gate that matters is the one on the route and not a
// copy of it in a test. The route TABLE itself is read too, so a route added
// later without a gate fails here rather than in production.
//
// THE ONE THIS MILESTONE WAS ASKED FOR: décor at `view` must be refused a
// heart and a finalise. That is asserted below both as a gate result and as a
// property of the table — every write in this feature asks for `edit`.
const fs = require("fs");
const path = require("path");
const { RequireSection } = require("../middlewares/coupleAuth");
const permissions = require("../services/CouplePermissions");
const planningRoutes = require("../routes/coupleApp-planning");
const { SECTION, ACCESS_LEVEL } = require("../utils/coupleEnums");

const { FromCaller } = planningRoutes;

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${JSON.stringify(got)} vs ${JSON.stringify(want)})`);

/** Minimal express stand-ins — the shape the other couple-app gate tests use. */
const run = (middleware, couple, over = {}) =>
  new Promise((resolve) => {
    let statusCode = 200, payload = null, nexted = false;
    const req = { params: { id: "6512f0aa11bb22cc33dd44ff" }, headers: {}, body: {}, couple, ...over };
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

/** The gates exactly as routes/coupleApp-planning.js mounts them. */
const READS = [
  ["GET    /wedding/:id/venues",          RequireSection("decor", "view")],
  ["GET    /wedding/:id/decor",           RequireSection("decor", "view")],
  ["GET    /wedding/:id/budget",          RequireSection("decor", "view")],
  ["GET    /wedding/:id/store/catalogue", RequireSection("decor", "view")],
  ["GET    /wedding/:id/store/draft",     RequireSection("decor", "view")],
  ["GET    /wedding/:id/makeup",          RequireSection("decor", "view")],
];
const WRITES = [
  ["POST   /wedding/:id/budget/estimate",              RequireSection("decor", "edit")],
  ["PUT    /wedding/:id/budget/target",                RequireSection("decor", "edit")],
  ["POST   /wedding/:id/store/draft/items",            RequireSection("decor", "edit")],
  ["DELETE /wedding/:id/store/draft/items/:itemId",    RequireSection("decor", "edit")],
  ["POST   /wedding/:id/store/draft/send",             RequireSection("decor", "edit")],
  ["PUT    /wedding/:id/makeup/brief",                 RequireSection("decor", "edit")],
  ["POST   /venues/:id/react",                         RequireSection("decor", "edit")],
  ["POST   /venues/:id/offer/accept",                  RequireSection("decor", "edit")],
  ["POST   /venues/:id/enquire",                       RequireSection("decor", "edit")],
  ["POST   /decor/:id/heart",                          RequireSection("decor", "edit")],
  ["POST   /decor/:id/select-tier",                    RequireSection("decor", "edit")],
  ["POST   /decor/:id/finalise",                       RequireSection("decor", "edit")],
  ["POST   /makeup-bids/:id/accept",                   RequireSection("decor", "edit")],
];

(async () => {
  console.log("Both partners pass every planning endpoint:");
  for (const [name, gate] of READS.concat(WRITES)) {
    ok((await run(gate, partner)).nexted, `${name} — partner passes`);
  }

  console.log("\nDÉCOR AT `view` — the refusal this milestone was asked for:");
  {
    const viewer = member({ ...NOTHING, decor: "view" });
    for (const [name, gate] of READS) {
      ok((await run(gate, viewer)).nexted, `${name} — a viewer may READ it`);
    }
    for (const [name, gate] of WRITES) {
      const res = await run(gate, viewer);
      eq(res.nexted, false, `${name} — a viewer is REFUSED`);
      eq(res.statusCode, 403, `${name} — 403`);
      eq(res.payload.error, "forbidden", `${name} — with the foundation's own refusal shape`);
      eq(res.payload.section, "decor", `${name} — naming the section`);
      eq(res.payload.required, "edit", `${name} — and the level it needed`);
      eq(res.payload.held, "view", `${name} — and the level they hold`);
    }
  }

  console.log("\nA HEART and a FINALISE in particular (§ 06.4, the named case):");
  {
    const viewer = member({ ...NOTHING, decor: "view" });
    const heart = await run(RequireSection("decor", "edit"), viewer);
    const fin = await run(RequireSection("decor", "edit"), viewer);
    eq(heart.nexted, false, "POST /decor/:id/heart — refused at view");
    eq(fin.nexted, false, "POST /decor/:id/finalise — refused at view");
    ok(String(heart.payload.message).indexOf("decor") !== -1, "and the message says which door is shut");
    eq(permissions.can(viewer, "decor", "edit"), false, "…because the matrix itself says no");
    eq(permissions.can(viewer, "decor", "view"), true, "while view still passes");
  }

  console.log("\nEvery level, on every planning gate:");
  for (const [name, gate] of READS.concat(WRITES)) {
    const needed = WRITES.some(([n]) => n === name) ? "edit" : "view";
    for (const held of ACCESS_LEVEL) {
      const res = await run(gate, member({ ...NOTHING, decor: held }));
      const shouldPass = ACCESS_LEVEL.indexOf(held) >= ACCESS_LEVEL.indexOf(needed);
      eq(res.nexted, shouldPass, `${name} — held "${held}", needs "${needed}"`);
    }
  }

  console.log("\nA member with EVERY OTHER section at edit and décor at none sees nothing:");
  {
    const elsewhere = member({ ...ALL_EDIT, decor: "none" });
    for (const [name, gate] of READS.concat(WRITES)) {
      const res = await run(gate, elsewhere);
      eq(res.nexted, false, `${name} — refused`);
      eq(res.payload.held, "none", `${name} — holding none of it`);
    }
  }

  console.log("\nAn invitation that was never opened, and one that was taken away:");
  {
    const never = member({ ...ALL_EDIT }, { acceptedAt: null });
    const revoked = member({ ...ALL_EDIT }, { revokedAt: new Date() });
    for (const [name, gate] of [READS[0], WRITES[0]]) {
      eq((await run(gate, never)).nexted, false, `${name} — an unopened invitation is not access`);
      eq((await run(gate, revoked)).nexted, false, `${name} — and neither is a revoked one`);
    }
    eq(permissions.isActiveMember(never.member), false, "isActiveMember is the one definition of 'still in'");
    eq(permissions.isActiveMember(revoked.member), false, "…and it refuses both");
  }

  console.log("\nNo req.couple at all is a 401, never a pass:");
  for (const [name, gate] of READS.concat(WRITES)) {
    const res = await run(gate, undefined);
    eq(res.nexted, false, `${name} — refused`);
    eq(res.statusCode, 401, `${name} — 401 unauthenticated`);
  }

  console.log("\nFAIL CLOSED — a fabricated section or level buys nothing:");
  {
    const overreach = member({ ...NOTHING, decor: "owner", planning: "edit", venues: "edit", store: "edit", makeup: "edit" });
    eq(permissions.levelFor(overreach, "decor"), "none", "a level outside the enum resolves to none");
    eq(permissions.levelFor(overreach, "planning"), "none", "and a section outside the six is none whatever it says");
    eq(SECTION.indexOf("venues"), -1, "\"venues\" is not a grantable section");
    eq(SECTION.indexOf("store"), -1, "nor \"store\"");
    eq(SECTION.indexOf("makeup"), -1, "nor \"makeup\"");
    eq(SECTION.indexOf("planning"), -1, "nor \"planning\"");
    eq(SECTION.length, 6, "there are exactly six, and this milestone added none");
    for (const [name, gate] of WRITES) {
      eq((await run(gate, overreach)).nexted, false, `${name} — still refused`);
    }
  }

  console.log("\nFromCaller refuses a signed-out stranger BEFORE any lookup:");
  {
    const gate = FromCaller({ missing: "We could not find that venue." });
    const res = await run(gate, undefined, { headers: {} });
    eq(res.nexted, false, "no Authorization header ⇒ refused");
    eq(res.statusCode, 401, "401");
    eq(res.payload.error, "unauthenticated", "in middlewares/coupleAuth's own shape");
    ok(!("weddingIds" in (res.payload || {})), "and it discloses nothing about which ids exist");
  }
  {
    const gate = FromCaller({ missing: "We could not find that venue." });
    const res = await run(gate, undefined, { headers: { authorization: "Bearer x" }, params: { id: "not-an-id" } });
    eq(res.statusCode, 400, "a malformed id is a 400 before anything is loaded");
  }
  {
    // The body may CLAIM a wedding — a claim is not a permission: CoupleAuth
    // runs next and refuses a caller who is not on it.
    const gate = FromCaller({ missing: "x" });
    const wedding = "6512f0aa11bb22cc33dd4400";
    const res = await run(gate, undefined, {
      headers: { authorization: "Bearer x" },
      params: { id: "6512f0aa11bb22cc33dd44ff" },
      body: { weddingId: wedding },
    });
    ok(res.nexted, "a body-supplied weddingId resolves");
    eq(res.req.params.id, wedding, "…by REWRITING :id, so the next middleware is the ordinary CoupleAuth");
    eq(res.req.coupleTargetId, "6512f0aa11bb22cc33dd44ff", "and the original target id is kept for the handler");
  }

  console.log("\nTHE ROUTE TABLE ITSELF (a route added without a gate fails here):");
  {
    const collect = (router) =>
      router.stack
        .filter((layer) => layer.route)
        .map((layer) => ({
          method: Object.keys(layer.route.methods)[0].toUpperCase(),
          path: layer.route.path,
          handlers: layer.route.stack.map((entry) => entry.name || "anonymous"),
        }));

    const weddingScoped = collect(planningRoutes);
    const itemScoped = collect(planningRoutes.itemRoutes);

    eq(weddingScoped.length, 12, "twelve wedding-scoped routes");
    eq(itemScoped.length, 7, "and seven at the API root");

    weddingScoped.forEach((route) => {
      ok(route.handlers.length >= 3, `${route.method} ${route.path} — auth + gate + handler`);
      ok(route.handlers.includes("CoupleAuth"), `${route.method} ${route.path} — mounts the REAL CoupleAuth`);
    });
    itemScoped.forEach((route) => {
      ok(route.handlers.length >= 4, `${route.method} ${route.path} — resolver + auth + gate + handler`);
      ok(route.handlers.includes("CoupleAuth"), `${route.method} ${route.path} — mounts the REAL CoupleAuth`);
      ok(route.handlers[0] !== "CoupleAuth", `${route.method} ${route.path} — resolves its wedding BEFORE CoupleAuth`);
    });

    // Every write is a write: nothing in this feature mutates behind a read gate.
    const source = fs.readFileSync(path.join(__dirname, "..", "routes/coupleApp-planning.js"), "utf8");
    const mounted = source.match(/RequireSection\("[a-z]+",\s*"[a-z]+"\)/g) || [];
    eq(mounted.length, 19, "nineteen section gates, one per route");
    ok(
      mounted.every((gate) => gate.indexOf('"decor"') !== -1),
      "and every one of them is the `decor` section — this feature grants nothing new"
    );
    eq(
      mounted.filter((gate) => gate.indexOf('"edit"') !== -1).length,
      13,
      "thirteen of them ask for edit — exactly the thirteen writes"
    );
    eq(
      mounted.filter((gate) => gate.indexOf('"view"') !== -1).length,
      6,
      "and six ask for view — exactly the six reads"
    );

    // A write can never be mounted at view: count the verbs and the levels.
    const writeVerbs = (source.match(/^(router|items)\.(post|put|patch|delete)\(/gm) || []).length;
    eq(writeVerbs, 13, "thirteen POST/PUT/PATCH/DELETE routes in the file");
    eq(
      writeVerbs,
      mounted.filter((gate) => gate.indexOf('"edit"') !== -1).length,
      "…which is exactly the number of `edit` gates — no write hides behind a read"
    );

    // FromDocument is the people milestone's, imported and not rewritten.
    ok(
      source.includes('require("./coupleApp-people")') && source.includes("FromDocument"),
      "FromDocument is IMPORTED from routes/coupleApp-people.js"
    );
    ok(
      !/const FromDocument\s*=/.test(source),
      "…and never redefined here — one membership resolution on this API, not two"
    );
    ok(
      !/resolveMembership|jwt\.verify|jsonwebtoken/.test(source),
      "no second membership test and no second token verification anywhere in the file"
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
