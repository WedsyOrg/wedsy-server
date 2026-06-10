/**
 * utils/venueEnquiryRateLimit.js
 *
 * Per-route rate limiting for the PUBLIC venue enquiry endpoint
 * (POST /venues/:slug/enquiry | /enquiries). Built on express-rate-limit
 * (already a project dependency; the global limiter in server.js uses it too).
 *
 * Two layers, both env-tunable, both returning a clean 429:
 *   1. Per IP            — default 5 / hour
 *   2. Per phone + venue — default 3 / day
 *
 * Unlike the global limiter, these do NOT skip localhost, so the limits apply
 * uniformly (and are testable from a local harness). The gated /manual route is
 * never wrapped by these.
 */
const rateLimit = require("express-rate-limit");

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

const IP_WINDOW_MS = num(process.env.VENUE_ENQUIRY_IP_WINDOW_MS, 60 * 60 * 1000); // 1h
const IP_MAX = num(process.env.VENUE_ENQUIRY_IP_MAX, 5);
const PHONE_WINDOW_MS = num(process.env.VENUE_ENQUIRY_PHONE_WINDOW_MS, 24 * 60 * 60 * 1000); // 1d
const PHONE_MAX = num(process.env.VENUE_ENQUIRY_PHONE_MAX, 3);

const message429 = {
  message: "Too many enquiries from this source. Please try again later.",
};

// Layer 1: per client IP.
const enquiryIpLimiter = rateLimit({
  windowMs: IP_WINDOW_MS,
  max: IP_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: message429,
});

// Pull the effective phone (couplePhone preferred, then phone), digits only.
function effectivePhone(req) {
  const raw = (req.body && (req.body.couplePhone || req.body.phone)) || "";
  return String(raw).replace(/\D/g, "");
}

// Layer 2: per phone number, scoped to the venue slug. Skips when no phone is
// present (the controller will 400 those) so the IP layer remains the guard.
const enquiryPhoneLimiter = rateLimit({
  windowMs: PHONE_WINDOW_MS,
  max: PHONE_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: message429,
  skip: (req) => !effectivePhone(req),
  keyGenerator: (req) => `${req.params.slug || "?"}:${effectivePhone(req)}`,
});

module.exports = { enquiryIpLimiter, enquiryPhoneLimiter };
