// INCIDENT FIX — per-user rate-limit keys. Run: node tests/rate-limit-per-user.test.js
// No DB needed. Covers: two admin tokens → independent buckets; the same
// token from two IPs → ONE bucket; anonymous → IP-keyed; garbage
// Authorization header → IP fallback without throwing. Plus an end-to-end
// pass through a REAL express-rate-limit instance (max 2) proving one user's
// 429 never touches the other's budget.
const jwt = require("jsonwebtoken");
const { rateLimit } = require("express-rate-limit");
const { keyGenerator } = require("../utils/rateLimitKey");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const SECRET = "test-secret";
const tokenA = jwt.sign({ _id: "adminAAAAAAAAAAAAAAAAAAA", isAdmin: true }, SECRET);
const tokenB = jwt.sign({ _id: "adminBBBBBBBBBBBBBBBBBBB", isAdmin: true }, SECRET);

const fakeReq = (ip, auth) => ({ ip, headers: auth ? { authorization: auth } : {} });

(async () => {
  // ── pure key assertions ──
  const a1 = keyGenerator(fakeReq("203.0.113.7", `Bearer ${tokenA}`));
  const a2 = keyGenerator(fakeReq("198.51.100.9", `Bearer ${tokenA}`)); // same token, other IP
  const b1 = keyGenerator(fakeReq("203.0.113.7", `Bearer ${tokenB}`)); // other token, same IP
  ok(a1 === "user:adminAAAAAAAAAAAAAAAAAAA", `bearer traffic keys on the token's id (${a1})`);
  ok(a1 === a2, "the SAME token from two IPs shares ONE bucket");
  ok(a1 !== b1, "two different admin tokens get independent buckets");

  const anon1 = keyGenerator(fakeReq("203.0.113.7"));
  const anon2 = keyGenerator(fakeReq("198.51.100.9"));
  ok(anon1 !== anon2 && !anon1.startsWith("user:"), "anonymous requests still key by IP");
  ok(anon1 === keyGenerator(fakeReq("203.0.113.7")), "same anonymous IP → same bucket");

  let threw = false;
  let garbage;
  try {
    garbage = keyGenerator(fakeReq("203.0.113.7", "Bearer not.a.jwt"));
  } catch {
    threw = true;
  }
  ok(!threw && garbage === anon1, "garbage bearer token falls back to the IP bucket without throwing");
  try {
    keyGenerator(fakeReq("203.0.113.7", "Negotiate blob"));
    keyGenerator(fakeReq(undefined, undefined));
    keyGenerator({});
  } catch {
    threw = true;
  }
  ok(!threw, "non-bearer schemes / missing ip / bare req never throw");

  // ── end-to-end through a real limiter (max 2 per window) ──
  const limiter = rateLimit({
    windowMs: 60_000,
    max: 2,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator,
    validate: false, // silence store-warnings in this synthetic harness
  });
  const hit = (ip, auth) =>
    new Promise((resolve) => {
      const req = fakeReq(ip, auth);
      req.app = { get: () => false };
      req.method = "GET";
      req.path = "/x";
      const res = {
        statusCode: 200,
        headersSent: false,
        setHeader() {}, getHeader() {}, removeHeader() {},
        status(c) { this.statusCode = c; return this; },
        send() { resolve({ limited: true, status: this.statusCode }); },
        json() { resolve({ limited: true, status: this.statusCode }); },
        end() { resolve({ limited: true, status: this.statusCode }); },
        on() {},
      };
      limiter(req, res, () => resolve({ limited: false }));
    });

  // Same office IP for everyone — the incident scenario.
  const IP = "203.0.113.7";
  const r1 = await hit(IP, `Bearer ${tokenA}`);
  const r2 = await hit(IP, `Bearer ${tokenA}`);
  const r3 = await hit(IP, `Bearer ${tokenA}`); // A's third → 429
  ok(!r1.limited && !r2.limited, "user A's first two requests pass");
  ok(r3.limited && r3.status === 429, "user A's runaway third request 429s");
  const rb = await hit(IP, `Bearer ${tokenB}`);
  ok(!rb.limited, "user B (same office IP) is UNTOUCHED by A's 429 — the incident is fixed");
  const ra2 = await hit("198.51.100.9", `Bearer ${tokenA}`);
  ok(ra2.limited, "user A can't dodge the bucket by switching IPs (token-keyed)");
  const anonHit1 = await hit(IP);
  ok(!anonHit1.limited, "anonymous traffic rides its own IP bucket");

  console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
