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

// Public read/beacon limiter (view tracking + availability-check). Generous —
// a couple browsing many venues is normal — but caps inflation/abuse per IP.
const PUBLIC_READ_WINDOW_MS = num(process.env.VENUE_PUBLIC_READ_WINDOW_MS, 60 * 1000); // 1m
const PUBLIC_READ_MAX = num(process.env.VENUE_PUBLIC_READ_MAX, 60);
const publicReadLimiter = rateLimit({
  windowMs: PUBLIC_READ_WINDOW_MS,
  max: PUBLIC_READ_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests, please slow down." },
});

// Owner-triggered Google reviews refresh — quota-guarding, deliberately tight.
const REVIEWS_REFRESH_WINDOW_MS = num(process.env.VENUE_REVIEWS_REFRESH_WINDOW_MS, 60 * 60 * 1000); // 1h
const REVIEWS_REFRESH_MAX = num(process.env.VENUE_REVIEWS_REFRESH_MAX, 4);
const reviewsRefreshLimiter = rateLimit({
  windowMs: REVIEWS_REFRESH_WINDOW_MS,
  max: REVIEWS_REFRESH_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Reviews were refreshed recently — try again in a bit." },
});

// Member email+password login (RBAC v2) — its own bucket so shared public-read
// exhaustion never locks members out, sized against credential stuffing.
const MEMBER_AUTH_WINDOW_MS = num(process.env.VENUE_MEMBER_AUTH_WINDOW_MS, 10 * 60 * 1000); // 10m
const MEMBER_AUTH_MAX = num(process.env.VENUE_MEMBER_AUTH_MAX, 20);
const memberAuthLimiter = rateLimit({
  windowMs: MEMBER_AUTH_WINDOW_MS,
  max: MEMBER_AUTH_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many login attempts — try again in a few minutes." },
});

module.exports = { enquiryIpLimiter, enquiryPhoneLimiter, publicReadLimiter, reviewsRefreshLimiter, memberAuthLimiter };
