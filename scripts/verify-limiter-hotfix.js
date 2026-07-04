/**
 * Verification for the limiter hotfix (claude/limiter-hotfix).
 * Run against a locally booted server: node scripts/verify-limiter-hotfix.js [port]
 *
 * Uses X-Forwarded-For (trust proxy = 1) so requests are NOT exempted by the
 * limiters' localhost skip — i.e. the limiters are genuinely exercised.
 *
 * Checks:
 *  1. 300 x GET /wa/conversations  -> zero 429 (exempt from general limiter)
 *  2. 300 x GET /auth/admin        -> zero 429 (exempt from general limiter)
 *  3. 30 x POST /auth/admin        -> 429 after 20 (strict login limiter)
 *  4. Lifecycle smoke: lead list + dashboard respond (non-5xx, non-429)
 */
const PORT = process.argv[2] || 8123;
const BASE = `http://localhost:${PORT}`;
const XFF = { "X-Forwarded-For": "203.0.113.7" };
const XFF2 = { "X-Forwarded-For": "203.0.113.99" };

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function tally(n, method, path, headers, body) {
  const counts = {};
  for (let i = 0; i < n; i++) {
    const res = await fetch(BASE + path, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    counts[res.status] = (counts[res.status] || 0) + 1;
    await res.arrayBuffer();
  }
  return counts;
}

(async () => {
  // 1. Chat polling reads never 429
  const wa = await tally(300, "GET", "/wa/conversations", XFF);
  check("300x GET /wa/conversations: zero 429", !wa["429"], JSON.stringify(wa));

  // 2. Session verification never 429
  const auth = await tally(300, "GET", "/auth/admin", XFF);
  check("300x GET /auth/admin: zero 429", !auth["429"], JSON.stringify(auth));

  // 3. Strict login limiter: 20 allowed, then 429 (fresh IP so counts are clean)
  const statuses = [];
  for (let i = 0; i < 30; i++) {
    const res = await fetch(BASE + "/auth/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...XFF2 },
      body: JSON.stringify({ email: "nobody@example.com", password: "wrong" }),
    });
    statuses.push(res.status);
    await res.arrayBuffer();
  }
  const first429 = statuses.indexOf(429);
  const allAfter429 = first429 >= 0 && statuses.slice(first429).every((s) => s === 429);
  check(
    "POST /auth/admin: strict limit kicks in at request 21",
    first429 === 20 && allAfter429,
    `first 429 at index ${first429} (0-based), statuses 18..23 = ${statuses.slice(18, 24).join(",")}`
  );

  // 4. Lifecycle smoke: lead list + dashboard respond (auth rejects, but the
  //    routes are alive and not rate-limited / 5xx)
  for (const path of ["/enquiry", "/stats"]) {
    const res = await fetch(BASE + path, { headers: XFF });
    await res.arrayBuffer();
    check(`smoke GET ${path} responds`, res.status < 500 && res.status !== 429, `status ${res.status}`);
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
