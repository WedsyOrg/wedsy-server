/* THE GUEST'S SIDE — /site/:slug, its RSVP and its password (§ 06.2, § 06.4).
 *
 * Three unauthenticated endpoints. Nobody here has a token, nobody here is a
 * member of anything, and the only thing that identifies the caller is a slug
 * they were sent in a WhatsApp message. So every rule this file follows is a
 * rule about what a stranger may be given:
 *
 *   • THE WITHHOLDING (§ 06.4). A gated site that has not proved its password
 *     gets the seven-key shell and nothing more. The decision is made in
 *     CoupleWebsiteRules.publicPayload — one function, one place — and this
 *     file's only job is to tell it whether the request proved an unlock.
 *
 *   • THE HASH NEVER LEAVES. `privacy.password` is `select: false` on the
 *     model, is loaded here ONLY so bcrypt.compare has something to compare
 *     against, and is never handed to a shaping function that emits it.
 *
 *   • THE RSVP INVARIANT IS CALLED, NOT REIMPLEMENTED (§ 06.3 #4). Every
 *     decision about a reply — the phone match on both-sides-normalised
 *     numbers, the create-if-unmatched, the 409 on a second reply, the
 *     Activity, and the headcount recomputed WITH the reply applied — comes
 *     from services/CoupleRsvpService.applyRsvp. There is no phone comparison,
 *     no `party` sum and no guest-matching branch anywhere in this file.
 *
 * Rate limiting is not here either: it is mounted on the routes, in
 * utils/coupleSiteRateLimit.js, keyed on IP AND slug (§ 06.4).
 */

const bcrypt = require("bcrypt");

const Website = require("../models/Website");
const Event = require("../models/Event");
const Guest = require("../models/Guest");
const RegistryItem = require("../models/RegistryItem");
const RegistryFund = require("../models/RegistryFund");

const rules = require("./CoupleWebsiteRules");
const rsvpService = require("./CoupleRsvpService");
const headcountService = require("./CoupleHeadcountService");
const activityService = require("./CoupleActivityService");
const weddingService = require("./CoupleWeddingService");

const fail = (status, code, message, extra) => {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  if (extra) error.extra = extra;
  return error;
};

/**
 * The key that signs an unlock token.
 *
 * SITE_UNLOCK_SECRET when the deploy sets one; otherwise JWT_SECRET, which is
 * already a per-deploy secret this server cannot run without. There is
 * deliberately NO development default: a baked-in fallback would mean every
 * instance everywhere mints tokens each other accepts, and
 * `verifyUnlockToken` with no secret verifies nothing — so a misconfigured
 * deploy leaves a gated site gated rather than opening it to the world.
 */
const unlockSecret = () => process.env.SITE_UNLOCK_SECRET || process.env.JWT_SECRET || "";

/** Cookies are Secure unless the deploy says it is serving plain HTTP locally. */
const secureCookies = () => String(process.env.NODE_ENV || "").toLowerCase() === "production" || process.env.SITE_COOKIE_SECURE === "1";

/**
 * Resolve a slug to its website and its wedding.
 *
 * The hash comes back because `isGated` needs to know a hash EXISTS; nothing
 * downstream of here reads its value except bcrypt.compare in unlock().
 */
const resolve = async (rawSlug) => {
  const slug = rules.normaliseSlug(rawSlug);
  if (!slug) return null;
  const website = await Website.findOne({ slug }).select("+privacy.password").lean();
  if (!website) return null;
  const event = await Event.findById(website.weddingId).lean();
  // A website whose wedding was deleted is not a 500 and not a blank page: it
  // is an address with nothing behind it, which is a 404.
  if (!event) return null;
  return { slug, website, event };
};

/** The gift list, as a guest sees it on the site page (§ 05.1 shapes the registry page itself). */
const publicRegistry = async (weddingId) => {
  const [items, funds] = await Promise.all([
    RegistryItem.find({ weddingId, archivedAt: null }, { title: 1, price: 1, sortOrder: 1, pinned: 1 })
      .sort({ pinned: -1, sortOrder: 1 })
      .limit(60)
      .lean(),
    RegistryFund.find({ weddingId, archivedAt: null }, { title: 1, target: 1, raised: 1, sortOrder: 1 })
      .sort({ sortOrder: 1 })
      .limit(20)
      .lean(),
  ]);
  // LandingPage reads `[{ id, name, price } | { id, name, raised, goal }]`.
  return [
    ...items.map((item) => ({ id: String(item._id), name: item.title, price: Number(item.price) || 0 })),
    ...funds.map((fund) => ({ id: String(fund._id), name: fund.title, raised: Number(fund.raised) || 0, goal: Number(fund.target) || 0 })),
  ];
};

/**
 * GET /site/:slug — the public read.
 *
 * `req` is passed in whole so the unlock proof can be read from wherever it
 * arrived (header, query or cookie) by the pure `unlockTokenFrom`.
 */
const site = async (rawSlug, req) => {
  const found = await resolve(rawSlug);
  if (!found) throw fail(404, "not_found", "We could not find that wedding website.");

  const { slug, website, event } = found;
  const gated = rules.isGated(website);
  const unlocked = gated
    ? rules.verifyUnlockToken(slug, rules.unlockTokenFrom(req, slug), unlockSecret())
    : true;

  // Only read the gift list when it is going to be sent. A locked or
  // unpublished site does not query the couple's registry at all — the
  // withholding is a query that does not happen, not a field that is deleted.
  const wanted = Boolean(website.publishedAt) && unlocked && Boolean(website.sections && website.sections.registry);
  const registry = wanted ? await publicRegistry(website.weddingId) : [];

  return {
    payload: rules.publicPayload({ website, event, registry, unlocked, keyOf: weddingService.dayKey }),
    // For the route's cache headers: a gated site's unlocked HTML must never
    // be held anywhere shared, or one guest's unlock becomes everybody's.
    gated,
    unlocked,
    published: Boolean(website.publishedAt),
    linkOnly: Boolean(website.privacy && website.privacy.linkOnly),
  };
};

/**
 * POST /site/:slug/unlock — § 04.10's guest password.
 *
 * The compare is bcrypt's and happens here; the plaintext arrives, is
 * compared, and is not stored, logged or echoed. A success mints the token
 * GET /site/:slug will accept, and sets it as an httpOnly cookie so a browser
 * that comes back is not asked twice.
 */
const unlock = async (rawSlug, password, now = Date.now()) => {
  const found = await resolve(rawSlug);
  if (!found) throw fail(404, "not_found", "We could not find that wedding website.");

  const { slug, website } = found;
  const hash = (website.privacy && website.privacy.password) || "";

  const grant = () => {
    const token = rules.mintUnlockToken(slug, unlockSecret(), now);
    return {
      body: { ok: true, unlockToken: token, expiresAt: new Date(now + rules.TOKEN_TTL_MS).toISOString() },
      cookie: token ? rules.unlockCookieHeader(slug, token, { secure: secureCookies() }) : "",
    };
  };

  // Not gated at all: there is nothing to prove. The client only calls this
  // when `passwordRequired` was true, so this is the couple having just
  // removed the password mid-visit — an open door, answered as one.
  if (!hash) return grant();

  if (typeof password !== "string" || !password.length || password.length > 200) {
    return { status: 401, body: { ok: false, error: "wrong_password", message: "That is not the password on the invitation." } };
  }

  const matched = await bcrypt.compare(password, hash);
  if (!matched) {
    return { status: 401, body: { ok: false, error: "wrong_password", message: "That is not the password on the invitation." } };
  }
  return grant();
};

/**
 * POST /site/:slug/rsvp — a guest replying (§ 06.3 invariant 4).
 *
 * THE INVARIANT IS CALLED. `CoupleRsvpService.applyRsvp` decides everything:
 * whether this phone matches a guest the couple typed (both sides through
 * utils/phone), whether to update or create, whether this is a second reply
 * (409 already_replied), what the Activity says, and what the headcount is
 * with the reply applied. This function writes what it is told to write.
 *
 * ── WHY A GATED SITE'S RSVP IS NOT ITSELF GATED ────────────────────────────
 * wedsy-user's components/site/RsvpForm.js posts with no unlock proof of any
 * kind (the gate is enforced by the Next SSR route's own cookie, which never
 * reaches this server). Refusing an unlocked RSVP would therefore break every
 * gated wedding's reply form. The controls that matter here are the ones that
 * are actually about a reply: the phone must match or a new row is created,
 * a guest may only answer once, and the endpoint is rate-limited per IP and
 * per slug. Written up in docs/couple-app-api.md § Website as a client
 * contract gap, not left to be discovered.
 */
const rsvp = async (rawSlug, body, now = new Date()) => {
  const found = await resolve(rawSlug);
  if (!found) throw fail(404, "not_found", "We could not find that wedding website.");

  const { website, event } = found;
  // An unpublished website has no public RSVP form, so a POST at one is a
  // reply to something that does not exist yet.
  if (!website.publishedAt) throw fail(404, "not_found", "We could not find that wedding website.");

  const weddingId = website.weddingId;
  const guests = await Guest.find({ weddingId }).lean();
  // § 06.3 "Events": defined once on the Event, consumed here. A guest cannot
  // reply for a function this wedding does not have.
  const eventKeys = ((event.eventDays || []).map((day) => weddingService.dayKey(day && day.name)) || []).filter(Boolean);

  const decision = rsvpService.applyRsvp({ submission: body, guests, weddingId, eventKeys, now });
  if (!decision.ok) throw fail(decision.status, decision.body.error, decision.body.message || "That reply could not be saved.", decision.body);

  let guestId = decision.guestId ? String(decision.guestId) : null;

  if (decision.update) {
    await Guest.updateOne({ _id: decision.update._id }, { $set: decision.update.$set });
  } else if (decision.create) {
    const created = await Guest.create(decision.create);
    guestId = String(created._id);
  }

  // § 06.3 — ALWAYS an Activity, matched or not. The service built it in one
  // place precisely so no branch here could return without one; this call is
  // outside the if/else for the same reason.
  await activityService.record({
    weddingId,
    actorType: "guest",
    actor: { name: decision.activity.actorName },
    action: decision.activity.action,
    objectType: "guest",
    objectId: guestId,
    summary: decision.activity.summary,
    meta: { source: "website", slug: found.slug },
  });

  // ── NOTIFICATION TRIGGER, NOT ADDED HERE ─────────────────────────────────
  // A reply arriving is a moment the couple would like to hear about — but as
  // a DIGEST, not one message per guest (the in-app Activity above already
  // covers the individual reply). docs/couple-app-api.md § 6 names it. Triggers
  // only, through services/NotificationService.js, WhatsApp via the Meta Cloud
  // API — never Aisensy — and only after the Notification System spec in Notion.

  return { ...decision.response, guestId };
};

/**
 * The headcount a couple-facing website dashboard reads, from the SAME function
 * the RSVP response used. Exposed so no screen has a second way to count.
 */
const tallyFor = async (weddingId) =>
  headcountService.tally(await Guest.find({ weddingId }, { party: 1, rsvp: 1, events: 1 }).lean());

module.exports = { resolve, site, unlock, rsvp, tallyFor, unlockSecret, secureCookies, publicRegistry };
