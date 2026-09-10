/**
 * Couple app — THE WEDDING WEBSITE (§ 04), its PUBLIC PAGE and the guest RSVP
 * (§ 06.2, § 06.4). Mounted from routes/coupleApp.js, which is mounted at
 * /wedding; the public routes are exported as `.itemRoutes` and mounted at the
 * root by routes/router.js, exactly as routes/coupleApp-people.js does for its
 * child resources.
 *
 * ── TWO ROUTERS, AND WHY THEY ARE NOT THE SAME ROUTER ─────────────────────
 * `router`  — /wedding/:id/website*. EVERY route carries BOTH gates (§ 06.4):
 *             CoupleAuth (a User token, on a wedding this person is on) and
 *             RequireSection("website", "view"|"edit"). A route added here
 *             without one is a section the client's UI is the only thing
 *             hiding, which § 06.4 says is not a control.
 *
 * `items`   — /site/:slug*. UNAUTHENTICATED, by design: a guest tapped a link
 *             in WhatsApp and has no account. There is no CoupleAuth to mount
 *             and nothing to gate on, so the controls are different in kind:
 *
 *               · the WITHHOLDING RULE — a password-protected site that has
 *                 not proved an unlock is sent seven keys and no content, by
 *                 CoupleWebsiteRules.publicPayload (the one function that can
 *                 build that body)
 *               · bcrypt, server-side, on the unlock
 *               · RATE LIMITS on both POSTs, keyed on IP **and** slug (§ 06.4)
 *
 * ── THE PUBLIC ROUTES MUST NOT SEE THE APP-WIDE BEARER LIMITER'S BUCKET ───
 * They are anonymous, so server.js's per-user keying falls back to per-IP for
 * them, which is why they carry limiters of their own rather than relying on
 * it (utils/coupleSiteRateLimit.js explains the keying and its honest limits).
 *
 * Every handler is wrapped in try/catch in controllers/coupleAppWebsite.js
 * (repo rule 5). No console.log anywhere in this feature (rule 6). No URL is
 * hardcoded (rule 3) — the published-site URL is built from
 * PUBLIC_SITE_BASE_URL when the deploy sets one, and is null when it does not.
 */
const express = require("express");
const fileUpload = require("express-fileupload");

const { CoupleAuth, RequireSection } = require("../middlewares/coupleAuth");
const { rsvpLimiter, unlockLimiter, siteReadLimiter } = require("../utils/coupleSiteRateLimit");
const website = require("../controllers/coupleAppWebsite");

const router = express.Router({ mergeParams: true });
const items = express.Router({ mergeParams: true });

/* ── the couple's builder — /wedding/:id/website ──────────────────────────── */

/* The slug check is registered before the bare /website paths for readability;
   they are distinct paths, not shadowed ones. */
router.get("/:id/website/slug/check", CoupleAuth, RequireSection("website", "view"), website.CheckSlug);

router.get("/:id/website", CoupleAuth, RequireSection("website", "view"), website.GetWebsite);
router.put("/:id/website", CoupleAuth, RequireSection("website", "edit"), website.SaveWebsite);

/* The debounced words-and-photographs save. Keyed by blockId and slotId, never
   by theme (§ 04.10) — which is what carries the couple's work across a theme
   switch, since the settings route above cannot emit either map. */
router.put("/:id/website/content", CoupleAuth, RequireSection("website", "edit"), website.SaveContent);

/* Multipart, on this route only — mounted here rather than app-wide so every
   other route keeps the JSON body parser (routes/file.js does the same).
   The size cap is enforced twice: by the middleware, so a 200MB body is never
   buffered, and by the service, so the limit is a rule and not a config. */
router.post(
  "/:id/website/photos",
  CoupleAuth,
  RequireSection("website", "edit"),
  fileUpload({ limits: { fileSize: 12 * 1024 * 1024 }, abortOnLimit: true, parseNested: true }),
  website.UploadPhoto
);

router.post("/:id/website/publish", CoupleAuth, RequireSection("website", "edit"), website.PublishWebsite);

/* ── the guest's page — PUBLIC, unauthenticated, rate-limited (§ 06.4) ────── */

items.get("/site/:slug", siteReadLimiter, website.GetPublicSite);
items.post("/site/:slug/rsvp", rsvpLimiter, website.PostRsvp);
items.post("/site/:slug/unlock", unlockLimiter, website.PostUnlock);

module.exports = router;
// Mounted at the API root by routes/router.js so a guest's link is
// wedsy.in-relative `/site/:slug` and not `/wedding/site/:slug`.
module.exports.itemRoutes = items;
