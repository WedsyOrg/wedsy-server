/**
 * RBAC — Local enforcement test harness
 *
 * Probes the LOCAL running server over HTTP (no direct DB access) so requests go
 * through the real middleware pipeline (CheckAdminLogin -> requirePermission).
 *
 * Auth scheme (per middlewares/auth.js CheckAdminLogin): the admin JWT is read
 * from `Authorization: Bearer <token>` — it does `authorization.split(" ")[1]`.
 *
 * Flow:
 *   1. Log in both seeded test admins via POST /auth/admin, grab `token`.
 *   2. For each route in ROUTES, call it with each admin's token.
 *   3. Print one line per route:  GET /role   founder=<status>   salesexec=<status>
 *
 * Read-only HTTP probing only. No DB writes.
 *
 * Prereqs: local server running at BASE_URL, test admins seeded
 * (scripts/rbac-local-seed-test-admins.js), and lead fixtures seeded
 * (scripts/rbac-local-seed-lead-fixtures.js) for the scope checks.
 *
 * Run: node scripts/rbac-local-test-enforcement.js
 */

const axios = require("axios");

const BASE_URL = "http://localhost:8090";

// Edit this list to add more routes to probe.
// Bogus 24-hex ObjectId: valid format, but never matches a real doc -> handler 404s
// for a permitted admin (passes auth, then fails AFTER), while a denied admin 403s
// at the middleware. The empty body guarantees nothing can mutate even if it didn't 404.
const BOGUS_ID = "000000000000000000000000";

const ROUTES = [
  { method: "GET", path: "/role" },
  // UpdatePermissions (PUT /role/:id) — already enforced with roles:edit:all.
  // founder -> passes auth, 404 (role not found); salesexec -> 403 at middleware.
  { method: "PUT", path: `/role/${BOGUS_ID}`, body: { permissions: [] } },
  // admin.GetAll (GET /admin) — gated with users:view:all. Read-only, no mutation.
  // founder -> passes auth, 200; salesexec -> 403 at middleware.
  { method: "GET", path: "/admin" },
];

const ADMINS = [
  { key: "founder", email: "test-founder@local.test", password: "LocalTest123!" },
  { key: "salesexec", email: "test-salesexec@local.test", password: "LocalTest123!" },
  { key: "revenuehead", email: "test-revenuehead@local.test", password: "LocalTest123!" },
  { key: "salesmgr", email: "test-salesmgr@local.test", password: "LocalTest123!" },
];

// axios client that never throws on non-2xx — we want to inspect every status.
const http = axios.create({
  baseURL: BASE_URL,
  validateStatus: () => true,
  timeout: 10000,
});

async function login({ email, password }) {
  let res;
  try {
    res = await http.post("/auth/admin", { email, password });
  } catch (err) {
    throw new Error(`request failed for ${email}: ${err.message}`);
  }
  if (res.status !== 200 || !res.data || !res.data.token) {
    const body = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
    throw new Error(`login failed for ${email}: status=${res.status} body=${body}`);
  }
  return res.data.token;
}

async function probe(route, token) {
  try {
    const res = await http.request({
      method: route.method,
      url: route.path,
      headers: { Authorization: `Bearer ${token}` },
      ...(route.body !== undefined ? { data: route.body } : {}),
    });
    return res.status;
  } catch (err) {
    return `ERR(${err.message})`;
  }
}

// Sentinel names of the seeded lead fixtures (scripts/rbac-local-seed-lead-fixtures.js).
const SENTINEL_SE = "ZZZ-RBAC-FIXTURE-HOT-SE"; // assigned to salesexec
const SENTINEL_F = "ZZZ-RBAC-FIXTURE-HOT-F"; // assigned to founder
const SENTINEL_MGR = "ZZZ-RBAC-FIXTURE-HOT-MGR"; // assigned to salesmgr

// Decode an admin _id from the login JWT payload (server signs { _id, isAdmin: true }).
// No verification needed — we only read the id to assert scope ownership of returned docs.
function adminIdFromToken(token) {
  const payload = token.split(".")[1] || "";
  const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  return JSON.parse(json)._id;
}

(async () => {
  // 1. Log in both admins (abort loudly on failure).
  const tokens = {};
  for (const admin of ADMINS) {
    try {
      tokens[admin.key] = await login(admin);
      console.log(`[login] ok: ${admin.email} (${admin.key})`);
    } catch (err) {
      console.error(`ABORT: ${err.message}`);
      process.exit(1);
    }
  }

  console.log("");

  // 2. RBAC scope assertions (read-only) against the seeded lead fixtures.
  //    Prereq: scripts/rbac-local-seed-lead-fixtures.js has been run.
  console.log("RBAC scope checks (lead read routes):");
  let failures = 0;
  const check = (label, ok, detail) => {
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? "  — " + detail : ""}`);
    if (!ok) failures++;
  };

  const salesexecId = adminIdFromToken(tokens.salesexec);
  const founderId = adminIdFromToken(tokens.founder); // resolved for symmetry / debugging

  const listAs = async (token, query = "") => {
    const res = await http.get(`/enquiry${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const list = res.data && Array.isArray(res.data.list) ? res.data.list : [];
    return { status: res.status, list };
  };
  const names = (list) => list.map((d) => d.name);
  const detailStatus = async (id, token) => {
    const res = await http.get(`/enquiry/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.status;
  };

  // High limit so assertions see the whole scoped set, not just page 1.
  const Q = "?limit=1000";
  const QHOT = "?status=Hot&limit=1000";

  // 1. founder unfiltered list contains BOTH fixtures.
  {
    const { list } = await listAs(tokens.founder, Q);
    const n = names(list);
    check(
      "founder GET /enquiry contains HOT-SE and HOT-F",
      n.includes(SENTINEL_SE) && n.includes(SENTINEL_F),
      `SE=${n.includes(SENTINEL_SE)} F=${n.includes(SENTINEL_F)}`
    );
  }

  // 2. salesexec unfiltered list: all own, has HOT-SE, not HOT-F.
  {
    const { list } = await listAs(tokens.salesexec, Q);
    const n = names(list);
    check(
      "salesexec GET /enquiry: every doc assignedTo === salesexec",
      list.every((d) => String(d.assignedTo) === String(salesexecId)),
      `docs=${list.length}`
    );
    check("salesexec GET /enquiry contains HOT-SE", n.includes(SENTINEL_SE));
    check("salesexec GET /enquiry does NOT contain HOT-F", !n.includes(SENTINEL_F));
  }

  // 3. founder ?status=Hot contains BOTH fixtures (aggregate branch).
  {
    const { list } = await listAs(tokens.founder, QHOT);
    const n = names(list);
    check(
      "founder GET /enquiry?status=Hot contains HOT-SE and HOT-F",
      n.includes(SENTINEL_SE) && n.includes(SENTINEL_F),
      `SE=${n.includes(SENTINEL_SE)} F=${n.includes(SENTINEL_F)}`
    );
  }

  // 4. salesexec ?status=Hot: all own, has HOT-SE, not HOT-F (bypass-closed proof).
  {
    const { list } = await listAs(tokens.salesexec, QHOT);
    const n = names(list);
    check(
      "salesexec GET /enquiry?status=Hot: every doc assignedTo === salesexec",
      list.every((d) => String(d.assignedTo) === String(salesexecId)),
      `docs=${list.length}`
    );
    check("salesexec GET /enquiry?status=Hot contains HOT-SE", n.includes(SENTINEL_SE));
    check(
      "salesexec GET /enquiry?status=Hot does NOT contain HOT-F (bypass closed)",
      !n.includes(SENTINEL_F)
    );
  }

  // 5. detail reads: out-of-scope id reads as 404 (no existence leak). Resolve ids by sentinel.
  {
    const { list } = await listAs(tokens.founder, Q);
    const hotF = list.find((d) => d.name === SENTINEL_F);
    const hotSE = list.find((d) => d.name === SENTINEL_SE);
    if (!hotF || !hotSE) {
      check(
        "resolve fixture _ids from founder list",
        false,
        "HOT-F/HOT-SE missing — run rbac-local-seed-lead-fixtures.js"
      );
    } else {
      check(
        "founder GET /enquiry/{HOT-F} -> 200",
        (await detailStatus(hotF._id, tokens.founder)) === 200
      );
      check(
        "salesexec GET /enquiry/{HOT-F} -> 404 (out-of-scope, no leak)",
        (await detailStatus(hotF._id, tokens.salesexec)) === 404
      );
      check(
        "salesexec GET /enquiry/{HOT-SE} -> 200",
        (await detailStatus(hotSE._id, tokens.salesexec)) === 200
      );
    }
  }

  // 6. TEAM-SCOPE checks (read-only): managers see their team's leads, executives
  //    see only their own. Chain: founder -> revenuehead -> salesmgr -> salesexec.
  //    HOT-SE -> salesexec, HOT-MGR -> salesmgr, HOT-F -> founder.
  {
    // a. salesmgr unfiltered list: own (HOT-MGR) + team (HOT-SE), not founder's (HOT-F).
    {
      const { list } = await listAs(tokens.salesmgr, Q);
      const n = names(list);
      check(
        "salesmgr GET /enquiry contains HOT-SE and HOT-MGR",
        n.includes(SENTINEL_SE) && n.includes(SENTINEL_MGR),
        `SE=${n.includes(SENTINEL_SE)} MGR=${n.includes(SENTINEL_MGR)}`
      );
      check("salesmgr GET /enquiry does NOT contain HOT-F", !n.includes(SENTINEL_F));
    }

    // b. revenuehead unfiltered list: team rolls up the chain — sees HOT-SE + HOT-MGR, not HOT-F.
    {
      const { list } = await listAs(tokens.revenuehead, Q);
      const n = names(list);
      check(
        "revenuehead GET /enquiry contains HOT-SE and HOT-MGR",
        n.includes(SENTINEL_SE) && n.includes(SENTINEL_MGR),
        `SE=${n.includes(SENTINEL_SE)} MGR=${n.includes(SENTINEL_MGR)}`
      );
      check("revenuehead GET /enquiry does NOT contain HOT-F", !n.includes(SENTINEL_F));
    }

    // c. salesexec unfiltered list: own only — HOT-SE, not HOT-MGR, not HOT-F.
    {
      const { list } = await listAs(tokens.salesexec, Q);
      const n = names(list);
      check("salesexec GET /enquiry contains HOT-SE (team-scope section)", n.includes(SENTINEL_SE));
      check("salesexec GET /enquiry does NOT contain HOT-MGR", !n.includes(SENTINEL_MGR));
      check("salesexec GET /enquiry does NOT contain HOT-F (team-scope section)", !n.includes(SENTINEL_F));
    }

    // d. detail reads: salesmgr can read a team member's lead; salesexec cannot read up the chain.
    {
      const { list } = await listAs(tokens.founder, Q);
      const hotSE = list.find((d) => d.name === SENTINEL_SE);
      const hotMgr = list.find((d) => d.name === SENTINEL_MGR);
      if (!hotSE || !hotMgr) {
        check(
          "resolve team-scope fixture _ids from founder list",
          false,
          "HOT-SE/HOT-MGR missing — run rbac-local-seed-lead-fixtures.js"
        );
      } else {
        check(
          "salesmgr GET /enquiry/{HOT-SE} -> 200 (team member's lead)",
          (await detailStatus(hotSE._id, tokens.salesmgr)) === 200
        );
        check(
          "salesexec GET /enquiry/{HOT-MGR} -> 404 (out-of-scope, no leak)",
          (await detailStatus(hotMgr._id, tokens.salesexec)) === 404
        );
      }
    }
  }

  console.log("");

  // 3. Probe each route with each admin's token.
  for (const route of ROUTES) {
    const founderStatus = await probe(route, tokens.founder);
    const salesexecStatus = await probe(route, tokens.salesexec);
    console.log(
      `${route.method} ${route.path}   founder=${founderStatus}   salesexec=${salesexecStatus}`
    );
  }

  if (failures > 0) {
    console.log(`\n${failures} scope check(s) FAILED.`);
    process.exitCode = 1;
  } else {
    console.log("\nAll scope checks passed.");
  }
})();
