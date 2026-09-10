// COUPLE APP — VENUES, DÉCOR, BUDGET, THE STORE AND MAKEUP
// (§ 3.2 – § 3.5, § 06.2).
//
// Same layering as controllers/coupleApp.js, coupleAppPeople.js,
// coupleAppWebsite.js and coupleAppMoney.js: the route mounts the gates, the
// controller calls a service and answers, the service owns the reads, the
// writes and the rules. Every handler is wrapped so no route in this file can
// throw out of an async callback (repo rule 5), and nothing here logs (rule 6)
// except the 500 path, which is what the other couple-app controllers do.
//
// AUTH IS NOT HERE. middlewares/coupleAuth resolves the caller and
// RequireSection("decor", …) refuses the section; a handler below may assume
// its route's gate has already passed. Every endpoint in this milestone lives
// behind the `decor` section, at `view` to read and `edit` to write — which is
// what makes "décor at view must be refused a heart or a finalise" a property
// of the route table rather than of anybody remembering.
const CoupleVenueService = require("../services/CoupleVenueService");
const CoupleDecorService = require("../services/CoupleDecorService");
const CoupleBudgetService = require("../services/CoupleBudgetService");
const CoupleStoreService = require("../services/CoupleStoreService");
const CoupleMakeupService = require("../services/CoupleMakeupService");
const Venue = require("../models/Venue");
const venueEnquiry = require("./venueEnquiry");

const respond = (res, error, fallback) => {
  const status = error && error.status ? error.status : 500;
  if (status === 500) console.error("[coupleAppPlanning]", error);
  res.status(status).send({
    error: status === 500 ? "server_error" : (error && error.code) || "error",
    message: status === 500 ? fallback : error.message,
    // A 422's per-field messages and a 409's `shown`/`now` ride along, so the
    // screen can point at the box that is wrong or say what changed.
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

/* ── venues (§ 3.2.1) — gated decor/view | decor/edit ─────────────────────── */

/** GET /wedding/:id/venues — the concierge shortlist, its holds and its chat. */
const GetVenues = wrap(async (req, res) => {
  res.status(200).send(await CoupleVenueService.get(req.couple));
}, "We could not open your venue options — please retry.");

/** POST /venues/:id/react { reaction: "love" | "maybe" | "pass" } */
const ReactVenue = wrap(async (req, res) => {
  res.status(200).send(await CoupleVenueService.react(req.couple, req.coupleTargetId, req.body));
}, "We could not save what you thought of that venue — please retry.");

/** POST /venues/:id/offer/accept { offerId } */
const AcceptVenueOffer = wrap(async (req, res) => {
  res.status(200).send(await CoupleVenueService.acceptOffer(req.couple, req.coupleTargetId, req.body));
}, "We could not accept that offer — please retry.");

/**
 * POST /venues/:id/enquire — the couple enquiring DIRECTLY, outside the
 * concierge thread (§ 3.4, and the `⛏ STUB` in wedsy-user's lib/plan/api.js).
 *
 * ── WHY THIS DELEGATES INSTEAD OF WRITING ──────────────────────────────────
 * A venue enquiry is not a row: it is a pipeline. controllers/venueEnquiry
 * .createEnquiry dedups it, round-robins it to a member of that venue's sales
 * team, seeds the lead's first contact and its interaction log, and — the part
 * that matters most for this app — OPENS THE VenueConversation that
 * `GET /wedding/:id/venues` then renders as the venue chat. Re-implementing any
 * of that would give the venue two kinds of lead, one of which their team's
 * scoping rules have never heard of.
 *
 * So this handler resolves the venue's slug, builds the body from the COUPLE'S
 * OWN RECORD, and hands over. The name and the phone number are never taken
 * from the request: they are the wedding's, so a couple cannot enquire in
 * somebody else's name.
 *
 * The public route (`POST /venues/:slug/enquiry`) is rate-limited per IP and
 * per phone because it is unauthenticated. This one is not, because it is
 * behind CoupleAuth and the `decor / edit` gate — a stronger control than a
 * bucket, and one that names who did it.
 */
const EnquireVenue = wrap(async (req, res) => {
  const venue = await Venue.findById(req.coupleTargetId, { slug: 1, name: 1 }).lean();
  if (!venue) {
    return res.status(404).send({ error: "not_found", message: "We could not find that venue." });
  }

  const event = req.couple.event;
  const partners = (event.coupleApp && event.coupleApp.partners) || [];
  const me = partners.find((partner) => partner && String(partner.user) === String(req.couple.userId));
  const coupleName =
    [event.brideName, event.groomName].filter(Boolean).join(" & ") ||
    (me && me.name) ||
    (req.couple.user && req.couple.user.name) ||
    "A Wedsy couple";
  const phone =
    (me && me.phone) ||
    (req.couple.user && req.couple.user.phone) ||
    (partners.find((partner) => partner && partner.phone) || {}).phone ||
    "";

  if (!phone) {
    return res.status(422).send({
      error: "validation",
      fields: { phone: "Add a phone number to your wedding first." },
      message: "The venue needs a number to call you back on.",
    });
  }

  const body = req.body || {};
  req.params.slug = venue.slug;
  req.body = {
    // The couple's own identity, from the wedding — never from the request.
    coupleName,
    couplePhone: phone,
    name: coupleName,
    phone,
    email: (me && me.email) || (req.couple.user && req.couple.user.email) || "",
    userId: String(req.couple.userId),
    eventDate: body.date || event.eventDate || undefined,
    guestCount: body.guests,
    message: String(body.note || "").slice(0, 2000),
    source: "wedsy",
  };
  // The existing pipeline answers this request itself (201 + the enquiry).
  return venueEnquiry.createEnquiry(req, res);
}, "We could not send that enquiry — please retry.");

/* ── décor (§ 3.2.2) — gated decor/view | decor/edit ──────────────────────── */

/** GET /wedding/:id/decor — per-day drafts and the five-state journey. */
const GetDecor = wrap(async (req, res) => {
  res.status(200).send(await CoupleDecorService.get(req.couple));
}, "We could not open your décor — please retry.");

/** POST /decor/:id/heart { themeId | productId } — a toggle. */
const HeartDecor = wrap(async (req, res) => {
  res.status(200).send(await CoupleDecorService.heart(req.couple, req.body));
}, "We could not save that — please retry.");

/** POST /decor/:id/select-tier { tier } */
const SelectTier = wrap(async (req, res) => {
  res.status(200).send(await CoupleDecorService.selectTier(req.couple, req.coupleTarget, req.body));
}, "We could not save your choice — please retry.");

/**
 * POST /decor/:id/finalise — IRREVERSIBLE (§ 06.2).
 *
 * Everything about it is CoupleDecorService.finalise → the foundation's
 * CoupleDecorFinaliseService → CoupleScheduleService. This handler holds no
 * arithmetic, no schedule and no idempotence logic of its own.
 */
const FinaliseDecor = wrap(async (req, res) => {
  res.status(200).send(await CoupleDecorService.finalise(req.couple, req.coupleTarget, req.body));
}, "We could not lock that in — nothing was committed. Please retry.");

/* ── budget (§ 3.2.3) — gated decor/view | decor/edit ─────────────────────── */

/** GET /wedding/:id/budget */
const GetBudget = wrap(async (req, res) => {
  res.status(200).send(await CoupleBudgetService.get(req.couple));
}, "We could not open your budget — please retry.");

/** POST /wedding/:id/budget/estimate */
const EstimateBudget = wrap(async (req, res) => {
  res.status(200).send(await CoupleBudgetService.estimate(req.couple, req.body));
}, "We could not work that out — please retry.");

/** PUT /wedding/:id/budget/target { target } */
const SetBudgetTarget = wrap(async (req, res) => {
  res.status(200).send(await CoupleBudgetService.setTarget(req.couple, req.body));
}, "We could not save your budget — please retry.");

/* ── the wedding store (§ 3.3) — gated decor/view | decor/edit ────────────── */

/** GET /wedding/:id/store/catalogue */
const GetCatalogue = wrap(async (req, res) => {
  res.status(200).send(await CoupleStoreService.catalogue());
}, "We could not open the store — please retry.");

/** GET /wedding/:id/store/draft */
const GetStoreDraft = wrap(async (req, res) => {
  res.status(200).send(await CoupleStoreService.draft(req.couple));
}, "We could not open your draft — please retry.");

/** POST /wedding/:id/store/draft/items { productId } */
const AddStoreItem = wrap(async (req, res) => {
  res.status(201).send(await CoupleStoreService.addItem(req.couple, req.body));
}, "We could not add that to your draft — please retry.");

/** DELETE /wedding/:id/store/draft/items/:itemId */
const RemoveStoreItem = wrap(async (req, res) => {
  res.status(200).send(await CoupleStoreService.removeItem(req.couple, req.params.itemId));
}, "We could not take that out of your draft — please retry.");

/** POST /wedding/:id/store/draft/send — creates a QuoteRequest (§ 06.3). */
const SendStoreDraft = wrap(async (req, res) => {
  res.status(200).send(await CoupleStoreService.send(req.couple, req.body));
}, "We could not send your draft — nothing has gone out. Please retry.");

/* ── makeup (§ 3.5) — gated decor/view | decor/edit ───────────────────────── */

/** GET /wedding/:id/makeup — { brief, bids[], trial, artists[] } */
const GetMakeup = wrap(async (req, res) => {
  res.status(200).send(await CoupleMakeupService.get(req.couple));
}, "We could not open your makeup bids — please retry.");

/** PUT /wedding/:id/makeup/brief */
const SaveMakeupBrief = wrap(async (req, res) => {
  res.status(200).send(await CoupleMakeupService.saveBrief(req.couple, req.body));
}, "We could not save your brief — please retry.");

/** POST /makeup-bids/:id/accept */
const AcceptBid = wrap(async (req, res) => {
  res.status(200).send(await CoupleMakeupService.acceptBid(req.couple, req.coupleTargetId));
}, "We could not book that artist — nothing has been agreed. Please retry.");

module.exports = {
  GetVenues,
  ReactVenue,
  AcceptVenueOffer,
  EnquireVenue,
  GetDecor,
  HeartDecor,
  SelectTier,
  FinaliseDecor,
  GetBudget,
  EstimateBudget,
  SetBudgetTarget,
  GetCatalogue,
  GetStoreDraft,
  AddStoreItem,
  RemoveStoreItem,
  SendStoreDraft,
  GetMakeup,
  SaveMakeupBrief,
  AcceptBid,
};
