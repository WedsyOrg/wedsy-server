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
 * Prereqs: local server running at BASE_URL, and test admins seeded
 * (scripts/rbac-local-seed-test-admins.js).
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

  // 2. Probe each route with each admin's token.
  for (const route of ROUTES) {
    const founderStatus = await probe(route, tokens.founder);
    const salesexecStatus = await probe(route, tokens.salesexec);
    console.log(
      `${route.method} ${route.path}   founder=${founderStatus}   salesexec=${salesexecStatus}`
    );
  }
})();
