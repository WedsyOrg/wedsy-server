/**
 * utils/coupleRegistryRateLimit.js
 *
 * § 06.4: "Rate-limit `POST /site/:slug/rsvp` and `/registry/:slug/contribute`."
 * The website milestone built the first half in utils/coupleSiteRateLimit.js.
 * This file is the second half, and it deliberately does NOT invent a second
 * way of throttling: the KEY — the part that decides who shares a bucket, and
 * therefore the only part with a security consequence — is imported from that
 * file. There is one `ipAndSlug` on this server, not two that could drift.
 *
 * Why a separate export rather than one more limiter in that file: the website
 * milestone owns it, and this milestone owns the money. A new file that imports
 * their rule is additive; editing theirs is not.
 *
 * ── WHY THE CONTRIBUTE BUCKET IS ITS OWN ──────────────────────────────────
 * Sharing the RSVP's bucket would mean a guest who replied to the invitation
 * twenty times could not then send a gift, and a family behind one office NAT
 * would spend each other's budget on two different things. Separate counters,
 * same key rule.
 *
 * ── THE LIMITS ────────────────────────────────────────────────────────────
 * Tighter than the RSVP, because this one moves money. Six gifts an hour from
 * one address on one wedding is a generous family; sixty is a card tester.
 *
 * ── THE HONEST SCOPE, REPEATED BECAUSE IT MATTERS MORE HERE ───────────────
 * express-rate-limit's default MEMORY STORE, exactly as the website's limiter
 * uses. So the ceiling is PER NODE PROCESS: behind two instances it is 2×, and
 * a restart forgives everything. For an RSVP that is fine. For a payment
 * endpoint it is a speed bump, not a control — the control against card
 * testing is the payment gateway's own fraud checks, and this limiter's job is
 * only to blunt a script. The day this server runs more than one instance,
 * this bucket wants a shared store (Redis) first. Written up in
 * docs/couple-app-api.md § Money rather than left to be found in an incident.
 */
const rateLimit = require("express-rate-limit");
const { ipAndSlug } = require("./coupleSiteRateLimit");

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** The 429 body wedsy-user's registryApi documents: `{ error: "rate_limited", retryAfter }`. */
const limited = (message) => (req, res) => {
  const retryAfter = Number(res.getHeader("Retry-After")) || null;
  res.status(429).send({ error: "rate_limited", retryAfter, message });
};

const CONTRIBUTE_WINDOW_MS = num(process.env.REGISTRY_CONTRIBUTE_WINDOW_MS, 60 * 60 * 1000);
const CONTRIBUTE_MAX = num(process.env.REGISTRY_CONTRIBUTE_MAX, 6);

const contributeLimiter = rateLimit({
  windowMs: CONTRIBUTE_WINDOW_MS,
  max: CONTRIBUTE_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipAndSlug,
  handler: limited("That is a few too many gifts from here just now. Please try again in a little while."),
});

module.exports = { contributeLimiter, CONTRIBUTE_WINDOW_MS, CONTRIBUTE_MAX };
