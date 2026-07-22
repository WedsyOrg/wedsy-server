// INCIDENT FIX — per-user rate-limit keys ("per-user keyed limits land in
// MB5", now landed). The office shares ONE public IP, so IP-keyed buckets let
// a single runaway client 429 the entire staff. Logged-in traffic keys on the
// bearer token's admin/user id instead; anonymous traffic stays IP-limited.
//
// jwt.decode (NOT verify) is deliberate: it's cheap (no crypto), and a forged
// id only buys the forger their own bucket — the auth middleware still does
// the real verification downstream. NEVER throws: any malformed header falls
// back to the IP key.
const jwt = require("jsonwebtoken");
const { ipKeyGenerator } = require("express-rate-limit");

const keyGenerator = (req) => {
  try {
    const auth = (req.headers && req.headers.authorization) || "";
    if (auth.startsWith("Bearer ")) {
      const decoded = jwt.decode(auth.slice(7));
      const id = decoded && (decoded._id || decoded.id || decoded.sub);
      if (id) return `user:${String(id)}`;
    }
  } catch {
    // fall through to the IP key — a garbage token must never take the app down
  }
  // ipKeyGenerator = express-rate-limit's IPv6-safe IP bucketing.
  return ipKeyGenerator(req.ip || "");
};

module.exports = { keyGenerator };
