// COUPLE APP — THE WEDDING WEBSITE, ITS PUBLIC PAGE AND THE GUEST RSVP (§ 04, § 06.2).
//
// Same layering as controllers/coupleApp.js and controllers/coupleAppPeople.js:
// the route mounts the gates and the limiters, the controller calls a service
// and answers, the service owns the reads and the rules. Every handler is
// wrapped so no route in this file can throw out of an async callback (repo
// rule 5), and nothing here logs (rule 6) except the 500 path, which is what
// the other couple-app controller does too.
//
// AUTH IS NOT HERE for the couple's six endpoints: middlewares/coupleAuth
// resolves the caller and RequireSection("website", …) refuses the section
// (§ 06.4). A handler below may assume `req.couple` is entitled to what its
// route mounted.
//
// AUTH IS NOT HERE for the three public ones either, and that is the point:
// they have none. What protects them is the withholding rule in
// CoupleWebsiteRules.publicPayload, bcrypt on the unlock, and the per-IP-and-
// slug limiters in utils/coupleSiteRateLimit.js.
const CoupleWebsiteService = require("../services/CoupleWebsiteService");
const CouplePublicSiteService = require("../services/CouplePublicSiteService");

const respond = (res, error, fallback) => {
  const status = error && error.status ? error.status : 500;
  if (status === 500) console.error("[coupleAppWebsite]", error);
  res.status(status).send({
    error: status === 500 ? "server_error" : (error && error.code) || "error",
    message: status === 500 ? fallback : error.message,
    // A 422's per-field messages, a 409's existing reply and a slug clash's
    // slug ride along, so the screen can point at the box that is wrong.
    ...((error && error.extra) || {}),
  });
};

// try/catch, once, for every route in this file (repo rule 5).
const wrap = (fn, fallback) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    respond(res, error, fallback);
  }
};

/* ── the couple's builder (§ 04) — gated website/view | website/edit ──────── */

/** GET /wedding/:id/website */
const GetWebsite = wrap(async (req, res) => {
  res.status(200).send(await CoupleWebsiteService.get(req.couple));
}, "We could not open your website — please retry.");

/** PUT /wedding/:id/website — theme, palette, typeface, sections, slug, privacy. */
const SaveWebsite = wrap(async (req, res) => {
  res.status(200).send(await CoupleWebsiteService.applySettings(req.couple, req.body));
}, "We could not save that change — please retry.");

/** PUT /wedding/:id/website/content — the debounced words-and-photographs save. */
const SaveContent = wrap(async (req, res) => {
  res.status(200).send(await CoupleWebsiteService.saveContent(req.couple, req.body));
}, "We could not save your words — please retry.");

/**
 * POST /wedding/:id/website/photos — multipart, one photograph, one slot.
 *
 * express-fileupload is mounted on this route only (as routes/file.js does),
 * so the JSON body parser keeps every other route.
 */
const UploadPhoto = wrap(async (req, res) => {
  const file = (req.files && (req.files.file || req.files.photo || req.files.image)) || null;
  const slotId = (req.body && (req.body.slotId || req.body.slot)) || "";
  res.status(201).send(await CoupleWebsiteService.uploadPhoto(req.couple, { slotId, file }));
}, "We could not upload that photograph — please retry.");

/** GET /wedding/:id/website/slug/check?slug= */
const CheckSlug = wrap(async (req, res) => {
  res.status(200).send(await CoupleWebsiteService.checkSlug(req.couple, req.query && req.query.slug));
}, "We could not check that address — please retry.");

/** POST /wedding/:id/website/publish */
const PublishWebsite = wrap(async (req, res) => {
  res.status(200).send(await CoupleWebsiteService.publish(req.couple));
}, "We could not publish your website — please retry.");

/* ── the guest's page (§ 06.2, § 06.4) — PUBLIC, unauthenticated ──────────── */

/**
 * GET /site/:slug — SSR read.
 *
 * The response CARRIES THE PRIVACY STATE THE PAGE NEEDS rather than leaving
 * the page to choose: `privacy.linkOnly` and `privacy.passwordRequired` are in
 * the body, and this handler additionally sets `X-Robots-Tag: noindex,
 * nofollow` itself whenever the site is link-only, gated or unpublished. The
 * client's <meta name="robots"> is a second belt on the same trousers; the
 * header is the server's own answer, and it is the one a crawler that never
 * runs JavaScript obeys.
 *
 * Cache-Control follows the same reasoning as wedsy-user's SSR route: a gated
 * site must never be held anywhere shared, or one guest's unlock becomes
 * everybody's.
 */
const GetPublicSite = wrap(async (req, res) => {
  const result = await CouplePublicSiteService.site(req.params.slug, req);

  if (result.linkOnly || result.gated || !result.published) {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
  }
  if (result.gated) {
    res.setHeader("Cache-Control", "private, no-store, must-revalidate");
    res.setHeader("Vary", "Cookie, X-Site-Unlock");
  } else if (result.published) {
    res.setHeader("Cache-Control", "public, max-age=0, s-maxage=60, stale-while-revalidate=300");
  } else {
    res.setHeader("Cache-Control", "no-store");
  }

  res.status(200).send(result.payload);
}, "We could not open that wedding website — please retry.");

/**
 * POST /site/:slug/rsvp — PUBLIC, rate-limited.
 *
 * Every decision belongs to services/CoupleRsvpService (§ 06.3 invariant 4);
 * this handler answers with what it decided. `headcount` in the body is the
 * server's, recomputed with the reply applied — the client never sums a party.
 */
const PostRsvp = wrap(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).send(await CouplePublicSiteService.rsvp(req.params.slug, req.body));
}, "We could not save your reply — please try again.");

/**
 * POST /site/:slug/unlock — PUBLIC, rate-limited, § 04.10.
 *
 * The bcrypt compare is server-side and the hash never leaves the database.
 * A success also sets an httpOnly cookie, so a guest who comes back to the
 * same website in the same browser is not asked twice.
 */
const PostUnlock = wrap(async (req, res) => {
  const result = await CouplePublicSiteService.unlock(req.params.slug, req.body && req.body.password);
  res.setHeader("Cache-Control", "no-store");
  if (result.cookie) res.setHeader("Set-Cookie", result.cookie);
  res.status(result.status || 200).send(result.body);
}, "We could not check that password — please try again.");

module.exports = {
  GetWebsite,
  SaveWebsite,
  SaveContent,
  UploadPhoto,
  CheckSlug,
  PublishWebsite,
  GetPublicSite,
  PostRsvp,
  PostUnlock,
};
