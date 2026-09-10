// COUPLE APP § 06.4 — EVERY REFUSAL PATH ON THE PEOPLE ENDPOINTS.
// Run: node tests/couple-people-permissions.test.js
//
// PURE unit tests (NO DATABASE). These run the REAL middlewares — the ones
// mounted in routes/coupleApp-people.js — against a fabricated `req.couple`,
// because the gate that matters is the one on the route and not a copy of it
// in a test.
//
// § 06.4: "Enforce SharedMember.access server-side on every endpoint. Hiding
// UI is a convenience, not a control." So: a member with `view` is refused
// every write, an invitation that was never opened is refused everything, a
// revoked member is refused immediately, and a member with all six sections at
// `edit` still cannot touch who else gets in.
const { RequireSection } = require("../middlewares/coupleAuth");
const peopleRoutes = require("../routes/coupleApp-people");
const rules = require("../services/CouplePeopleRules");

const { RequirePartner, RefuseMilestone, FromDocument } = peopleRoutes;

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${JSON.stringify(got)} vs ${JSON.stringify(want)})`);

/** Minimal express stand-ins — the same shape tests/couple-auth-membership.int.test.js uses. */
const run = (middleware, { params = {}, headers = {}, couple, kind } = {}) =>
  new Promise((resolve) => {
    let statusCode = 200, payload = null, nexted = false;
    const req = { params, headers, couple, coupleTargetKind: kind };
    const res = {
      status(c) { statusCode = c; return this; },
      send(p) { payload = p; resolve({ statusCode, payload, nexted, req }); return this; },
      json(p) { return this.send(p); },
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

/** The gates exactly as routes/coupleApp-people.js mounts them. */
const GATES = [
  ["GET  /wedding/:id/guests",           RequireSection("guests", "view"), "guests", "view"],
  ["GET  /wedding/:id/guests/headcount", RequireSection("guests", "view"), "guests", "view"],
  ["POST /wedding/:id/guests",           RequireSection("guests", "edit"), "guests", "edit"],
  ["PATCH  /guests/:id",                 RequireSection("guests", "edit"), "guests", "edit"],
  ["DELETE /guests/:id",                 RequireSection("guests", "edit"), "guests", "edit"],
  ["GET  /wedding/:id/tasks",            RequireSection("tasks", "view"),  "tasks",  "view"],
  ["POST /wedding/:id/tasks",            RequireSection("tasks", "edit"),  "tasks",  "edit"],
  ["PATCH  /tasks/:id",                  RequireSection("tasks", "edit"),  "tasks",  "edit"],
  ["DELETE /tasks/:id",                  RequireSection("tasks", "edit"),  "tasks",  "edit"],
];

(async () => {
  console.log("Both partners pass every people endpoint:");
  for (const [name, gate] of GATES) {
    const r = await run(gate, { couple: partner });
    ok(r.nexted, `${name} — a partner passes`);
  }
  {
    const r = await run(RequirePartner, { couple: partner });
    ok(r.nexted, "GET/POST /wedding/:id/members — a partner passes");
  }

  console.log("A member with nothing is refused everything:");
  for (const [name, gate, section, level] of GATES) {
    const r = await run(gate, { couple: member(NOTHING) });
    eq(r.statusCode, 403, `${name} — refused`);
    eq(r.payload.error, "forbidden", `${name} — the foundation's refusal shape`);
    eq(r.payload.section, section, `${name} — names the section`);
    eq(r.payload.required, level, `${name} — names the level it wanted`);
    eq(r.payload.held, "none", `${name} — and what they actually hold`);
    ok(typeof r.payload.message === "string" && r.payload.message.length > 0, `${name} — with something renderable`);
  }

  console.log("VIEW IS NOT EDIT — the read passes and the write does not:");
  {
    const viewer = member({ ...NOTHING, guests: "view", tasks: "view" });
    ok((await run(RequireSection("guests", "view"), { couple: viewer })).nexted, "guests: view may read the guest list");
    ok((await run(RequireSection("tasks", "view"), { couple: viewer })).nexted, "tasks: view may read the tasks");
    for (const [name, gate, , level] of GATES.filter((g) => g[3] === "edit")) {
      const r = await run(gate, { couple: viewer });
      eq(r.statusCode, 403, `${name} — a viewer is refused the write`);
      eq(r.payload.held, "view", `${name} — and told they hold view, not none`);
      eq(r.payload.required, level, `${name} — against the edit it needed`);
    }
  }

  console.log("EDIT PASSES — and only in the section it was granted:");
  {
    const guestsOnly = member({ ...NOTHING, guests: "edit" });
    ok((await run(RequireSection("guests", "edit"), { couple: guestsOnly })).nexted, "guests: edit may write guests");
    ok((await run(RequireSection("guests", "view"), { couple: guestsOnly })).nexted, "…and read them: edit outranks view");
    eq((await run(RequireSection("tasks", "view"), { couple: guestsOnly })).statusCode, 403,
       "…and still cannot see the tasks screen");
    const tasksOnly = member({ ...NOTHING, tasks: "edit" });
    ok((await run(RequireSection("tasks", "edit"), { couple: tasksOnly })).nexted, "tasks: edit may write tasks");
    eq((await run(RequireSection("guests", "view"), { couple: tasksOnly })).statusCode, 403,
       "…and cannot open the guest list");
  }

  console.log("An invitation that was never opened is not access:");
  {
    const pending = member(ALL_EDIT, { acceptedAt: null });
    for (const [name, gate] of GATES) {
      const r = await run(gate, { couple: pending });
      eq(r.statusCode, 403, `${name} — refused despite a full access map`);
      eq(r.payload.held, "none", `${name} — they hold nothing until they accept`);
    }
  }

  console.log("A revoked member is refused immediately:");
  {
    const revoked = member(ALL_EDIT, { revokedAt: new Date() });
    for (const [name, gate] of GATES) {
      const r = await run(gate, { couple: revoked });
      eq(r.statusCode, 403, `${name} — refused`);
      eq(r.payload.held, "none", `${name} — the map is irrelevant once it is taken away`);
    }
  }

  console.log("MEMBERS MANAGEMENT IS PARTNER-ONLY — no access map can reach it:");
  {
    const superMember = member(ALL_EDIT);
    const r = await run(RequirePartner, { couple: superMember });
    eq(r.statusCode, 403, "all six sections at edit, and still refused");
    eq(r.payload.error, "forbidden", "the foundation's refusal shape");
    eq(r.payload.section, "members", "it names members management");
    eq(r.payload.required, "partner", "…and that only a partner holds it");
    ok(/only the couple/i.test(r.payload.message), "in the product's voice");
    // The structural argument: there is no key to set.
    const map = rules.accessMapFrom({ ...ALL_EDIT, members: "edit", payouts: "edit" });
    eq(map.members, undefined, "…because a stored map has no 'members' key to hold the grant");
    eq(map.payouts, undefined, "nor a 'payouts' one");
    const stillRefused = await run(RequirePartner, { couple: { ...superMember, member: { ...superMember.member, access: { ...ALL_EDIT, members: "edit" } } } });
    eq(stillRefused.statusCode, 403, "a document hand-edited to carry the key changes nothing");
  }

  console.log("No caller at all:");
  {
    for (const [name, gate] of GATES) {
      const r = await run(gate, { couple: undefined });
      eq(r.statusCode, 401, `${name} — a request with no resolved caller is 401, not 403`);
      eq(r.payload.error, "unauthenticated", `${name} — and says so`);
    }
    const r = await run(RequirePartner, { couple: undefined });
    eq(r.statusCode, 401, "members management too");
    eq(r.payload.error, "unauthenticated", "…with the same body");
  }

  console.log("The CRM's timeline is refused as a WRITE, not as a 404:");
  {
    const refused = await run(RefuseMilestone, { couple: partner, kind: "milestone" });
    eq(refused.statusCode, 403, "a partner is refused a write to a milestone");
    eq(refused.payload.error, "forbidden", "the foundation's refusal shape");
    eq(refused.payload.section, "tasks", "it names the section");
    ok(/planner/i.test(refused.payload.message), "and says whose row it is");
    ok((await run(RefuseMilestone, { couple: partner, kind: "couple" })).nexted, "a CoupleTask passes");
    ok((await run(RefuseMilestone, { couple: partner, kind: undefined })).nexted, "…and so does anything not a milestone");
    // ORDER MATTERS: this gate is mounted AFTER CoupleAuth and RequireSection,
    // so a stranger is refused on the wedding first and never learns the row
    // exists. Asserted here as the mounted order in the route file.
    const source = require("fs").readFileSync(require("path").join(__dirname, "..", "routes/coupleApp-people.js"), "utf8");
    const patchTasks = source.slice(source.indexOf('items.patch(\n  "/tasks/:id"'));
    const authAt = patchTasks.indexOf("CoupleAuth");
    const sectionAt = patchTasks.indexOf('RequireSection("tasks", "edit")');
    const refuseAt = patchTasks.indexOf("RefuseMilestone");
    ok(authAt > 0 && sectionAt > authAt && refuseAt > sectionAt,
       "PATCH /tasks/:id mounts CoupleAuth, then the section gate, then the milestone refusal");
  }

  console.log("A child-resource route does not leak which ids exist:");
  {
    // FromDocument refuses a missing token BEFORE it looks anything up, so a
    // signed-out stranger cannot use PATCH /guests/:id to probe the database.
    let looked = false;
    const loader = async () => { looked = true; return null; };
    const r = await run(FromDocument(loader, "We could not find that guest."), { params: { id: "6512f0aa11bb22cc33dd44ee" }, headers: {} });
    eq(r.statusCode, 401, "no token is 401");
    eq(r.payload.error, "unauthenticated", "…in middlewares/coupleAuth's own body shape");
    eq(looked, false, "AND THE LOOKUP NEVER RAN");

    const bad = await run(FromDocument(loader, "nope"), { params: { id: "123456789012" }, headers: { authorization: "Bearer x" } });
    eq(bad.statusCode, 400, "a 12-character string is not an id — utils/objectId is strict about exactly this");
    const missing = await run(FromDocument(loader, "We could not find that guest."), { params: { id: "6512f0aa11bb22cc33dd44ee" }, headers: { authorization: "Bearer x" } });
    eq(missing.statusCode, 404, "a well-formed id for a row that is gone is 404");

    const found = await run(
      FromDocument(async () => ({ doc: { _id: "g1" }, weddingId: "6512f0aa11bb22cc33dd4400", kind: "guest" }), "nope"),
      { params: { id: "6512f0aa11bb22cc33dd44ee" }, headers: { authorization: "Bearer x" } }
    );
    ok(found.nexted, "a real row passes on to CoupleAuth");
    eq(found.req.params.id, "6512f0aa11bb22cc33dd4400",
       "…with :id rewritten to the wedding on the DOCUMENT, so the ONE membership test runs next");
    eq(found.req.coupleTargetId, "6512f0aa11bb22cc33dd44ee", "and the row's own id kept for the controller");

    const broke = await run(FromDocument(async () => { throw new Error("boom"); }, "nope"),
      { params: { id: "6512f0aa11bb22cc33dd44ee" }, headers: { authorization: "Bearer x" } });
    eq(broke.statusCode, 500, "a loader that throws is a 500, not an unhandled rejection");
    eq(broke.payload.error, "server_error", "…with a body");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
