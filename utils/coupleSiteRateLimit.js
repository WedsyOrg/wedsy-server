/**
 * utils/coupleSiteRateLimit.js
 *
 * § 06.4: "Rate-limit `POST /site/:slug/rsvp` and `/registry/:slug/contribute`."
 * This file covers the wedding website's two public POSTs — the RSVP and the
 * password unlock. Built on express-rate-limit, already a dependency and
 * already how utils/venueEnquiryRateLimit.js guards the other public form on
 * this server, so there is one idiom for public throttling here rather than two.
 *
 * ── KEYED ON IP **AND** SLUG ───────────────────────────────────────────────
 * Not IP alone: a family sharing one office NAT would spend one wedding's
 * budget on another's, and a single guest hammering one couple's gate would
 * throttle every other couple behind the same address. Not slug alone either:
 * that lets one attacker lock a wedding's real guests out of replying. The
 * bucket is the pair, so abuse is contained to the pair.
 *
 * `ipKeyGenerator` is express-rate-limit's own IPv6-safe bucketing — a raw
 * `req.ip` string keys every address in a /64 separately, which is no limit at
 * all against anyone with a modern connection.
 *
 * ── THE HONEST LIMIT OF THIS LIMITER ───────────────────────────────────────
 * The store is express-rate-limit's DEFAULT MEMORY STORE, so each Node process
 * counts on its own. Behind two instances the effective ceiling is 2×, and a
 * restart forgives everything. That is acceptable for a wedding RSVP (the
 * point is to blunt a script, not to be a quota) and is NOT acceptable for the
 * unlock endpoint if the guest password ever becomes the only thing protecting
 * something sensitive — that one wants a shared store (Redis) the day this
 * server runs more than one instance. Recorded in docs/couple-app-api.md
 * § Website rather than left for someone to find out during an incident.
 */
const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = require("express-rate-limit");

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** IP + slug. The slug is normalised the cheap way so "/Site/X" and "/site/x" share a bucket. */
const ipAndSlug = (req) => {
  const slug = String((req.params && req.params.slug) || "?").toLowerCase().slice(0, 80);
  return `${ipKeyGenerator(req.ip || "")}:${slug}`;
};

/** The 429 body wedsy-user's siteApi documents: `{ error: "rate_limited", retryAfter }`. */
const limited = (message) => (req, res) => {
  const retryAfter = Number(res.getHeader("Retry-After")) || null;
  res.status(429).send({ error: "rate_limited", retryAfter, message });
};

/* POST /site/:slug/rsvp — a real guest replies once. Twenty in an hour from one
   phone on one wedding is a script, not a family filling the form in together. */
const RSVP_WINDOW_MS = num(process.env.SITE_RSVP_WINDOW_MS, 60 * 60 * 1000);
const RSVP_MAX = num(process.env.SITE_RSVP_MAX, 20);

const rsvpLimiter = rateLimit({
  windowMs: RSVP_WINDOW_MS,
  max: RSVP_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipAndSlug,
  handler: limited("That is a few too many replies from here. Please try again a little later."),
});

/* POST /site/:slug/unlock — a password guess. Tighter, because this one is a
   credential: ten tries per ten minutes is a guest who mistyped, not a
   dictionary. */
const UNLOCK_WINDOW_MS = num(process.env.SITE_UNLOCK_WINDOW_MS, 10 * 60 * 1000);
const UNLOCK_MAX = num(process.env.SITE_UNLOCK_MAX, 10);

const unlockLimiter = rateLimit({
  windowMs: UNLOCK_WINDOW_MS,
  max: UNLOCK_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipAndSlug,
  // A correct password should not spend budget: a guest who gets in and
  // reloads must not be locked out of their friends' wedding.
  skipSuccessfulRequests: true,
  handler: limited("Too many tries. Please wait a few minutes and check the password on your invitation."),
});

/* GET /site/:slug — generous. A guest reloading a wedding website is normal;
   a crawler enumerating slugs is not. */
const READ_WINDOW_MS = num(process.env.SITE_READ_WINDOW_MS, 60 * 1000);
const READ_MAX = num(process.env.SITE_READ_MAX, 120);

const siteReadLimiter = rateLimit({
  windowMs: READ_WINDOW_MS,
  max: READ_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipAndSlug,
  handler: limited("Too many requests — please slow down."),
});

module.exports = { rsvpLimiter, unlockLimiter, siteReadLimiter, ipAndSlug };
