/**
 * Couple app — PLANNING: venues (§ 3.2.1), the décor journey (§ 3.2.2), the
 * budget estimator (§ 3.2.3), the Wedding Store (§ 3.3) and makeup (§ 3.5).
 * Mounted from routes/coupleApp.js, which is mounted at /wedding; the child
 * routes are exported as `.itemRoutes` and mounted at the API root by
 * routes/router.js (that line already exists).
 *
 * ── EVERY ROUTE CARRIES BOTH GATES (§ 06.4) ──────────────────────────────
 *   CoupleAuth      — a User token, on a wedding this person is actually on
 *   RequireSection  — `decor`, at `view` to read and `edit` to write
 *
 * All of it is one section on purpose. § 06.4's six sections are the couple's
 * own vocabulary and "décor" is the one the whole Planner, the Store, the
 * venue chat and the makeup round sit behind — a shared family member given
 * `decor: "view"` may read the venue options, the priced tiers, the budget and
 * the bids, and may not react, heart, choose a tier, change a budget, send a
 * draft, book an artist or finalise. Because the level is on the ROUTE, that is
 * a property of this table rather than of anybody remembering it in a handler:
 * `tests/couple-planning-permissions.test.js` walks the table and asserts every
 * write asks for `edit`.
 *
 * The two irreversible ones — `POST /decor/:id/finalise` and
 * `POST /makeup-bids/:id/accept` — carry no special gate beyond `decor/edit`,
 * and deliberately so: unlike a payout, committing the décor is something a
 * couple may genuinely ask a parent with edit rights to do, and the refusal
 * that matters (a member at `view`) is already the one above. The MONEY those
 * two commit still cannot be PAID by anybody but a partner — that is
 * RequirePayout on routes/coupleApp-money.js, unchanged.
 *
 * ── HOW THE CHILD ROUTES FIND THEIR WEDDING ──────────────────────────────
 * `/decor/:id/*` and `/makeup-bids/:id/accept` resolve it FROM THE DOCUMENT,
 * through `FromDocument` IMPORTED from routes/coupleApp-people.js — the same
 * one the guests, tasks, members, registry and payments routes use. Two
 * implementations of "which wedding does this row belong to" is exactly the
 * second membership test § 06.4 exists to prevent.
 *
 * `/venues/:id/*` cannot: a Venue belongs to no wedding — hundreds of couples
 * shortlist the same one. `FromCaller` below resolves it from the request
 * BODY's `weddingId` when the client sends one (`api.enquireVenue` and
 * `api.acceptBid` do), and otherwise from the caller's own weddings, narrowed
 * by which of them actually has this venue on its shortlist. It then rewrites
 * `:id` and hands over to the ORDINARY CoupleAuth, exactly as FromDocument
 * does — the resolution changes, the membership test does not.
 */
const express = require("express");

const { CoupleAuth, RequireSection } = require("../middlewares/coupleAuth");
const { FromDocument } = require("./coupleApp-people");
const { CheckToken } = require("../middlewares/auth");
const { isId } = require("../utils/objectId");

const Event = require("../models/Event");
const SharedMember = require("../models/SharedMember");
const VenueShortlist = require("../models/VenueShortlist");
const BiddingBid = require("../models/BiddingBid");
const Bidding = require("../models/Bidding");

const planning = require("../controllers/coupleAppPlanning");

const router = express.Router({ mergeParams: true });
const items = express.Router({ mergeParams: true });

/* ── resolving a wedding for the routes that carry no id ──────────────────── */

/** Every wedding this signed-in person is on. Partners first, then sharing. */
const weddingsFor = async (userId) => {
  const [owned, shared] = await Promise.all([
    Event.find(
      { $or: [{ user: userId }, { "coupleApp.partners.user": userId }] },
      { _id: 1, leadId: 1 }
    )
      .limit(10)
      .lean(),
    SharedMember.find(
      { user: userId, acceptedAt: { $ne: null }, revokedAt: null },
      { weddingId: 1 }
    )
      .limit(10)
      .lean(),
  ]);
  const ids = owned.map((event) => String(event._id));
  shared.forEach((member) => {
    if (member.weddingId) ids.push(String(member.weddingId));
  });
  return [...new Set(ids)];
};

/** Which of these weddings has this venue on its shortlist? */
const narrowByVenue = async (weddingIds, venueId) => {
  if (weddingIds.length < 2 || !isId(venueId)) return weddingIds;
  const events = await Event.find({ _id: { $in: weddingIds } }, { _id: 1, leadId: 1 }).lean();
  const withLeads = events.filter((event) => event.leadId);
  if (!withLeads.length) return weddingIds;
  const shortlists = await VenueShortlist.find(
    { crmEnquiryId: { $in: withLeads.map((event) => String(event.leadId)) }, "items.venue": venueId },
    { crmEnquiryId: 1 }
  ).lean();
  if (!shortlists.length) return weddingIds;
  const leadIds = new Set(shortlists.map((shortlist) => String(shortlist.crmEnquiryId)));
  const narrowed = withLeads
    .filter((event) => leadIds.has(String(event.leadId)))
    .map((event) => String(event._id));
  return narrowed.length ? narrowed : weddingIds;
};

/**
 * Discover the wedding for a route whose `:id` is NOT a wedding and NOT a row
 * that belongs to one, then hand over to CoupleAuth.
 *
 * Three sources, in this order:
 *
 *   1. `req.body.weddingId`. The client already sends it on two of these
 *      (`api.enquireVenue`, `api.acceptBid`), and it is the caller SAYING
 *      which wedding — which is a claim, not a permission. CoupleAuth refuses
 *      it a moment later if they are not on it, so an id sent by a stranger
 *      buys them a 403 and nothing else.
 *   2. `load(:id)` — the document, where there is one (a bid knows its round,
 *      and a round that was posted from this app knows its wedding).
 *   3. THE CALLER's own weddings, narrowed by `narrow` when the route has
 *      something to narrow with. Exactly one ⇒ that one. None ⇒ 404. More than
 *      one ⇒ 409 asking for a `weddingId`, because guessing which of a
 *      person's two weddings a reaction belongs to is worse than asking.
 *
 * The token is refused BEFORE any lookup, with middlewares/coupleAuth's own
 * body, so a signed-out stranger cannot use these routes to probe which venue
 * or bid ids exist. Identity comes from `middlewares/auth.CheckToken` — this
 * repo's own token middleware, called rather than re-implemented; it never
 * refuses, so the refusal stays CoupleAuth's, in the couple app's shape.
 */
const FromCaller = ({ load, narrow, missing } = {}) => async (req, res, next) => {
  try {
    if (!req.headers.authorization) {
      return res.status(401).send({ error: "unauthenticated", message: "Please sign in to open your wedding." });
    }
    const targetId = req.params.id;
    if (!isId(targetId)) return res.status(400).send({ error: "bad_request", message: missing });
    req.coupleTargetId = targetId;

    // 1 · the body said so.
    const claimed = req.body && req.body.weddingId;
    if (isId(claimed)) {
      req.params.id = String(claimed);
      return next();
    }

    // 2 · the document knows.
    if (load) {
      const found = await load(targetId);
      if (found && found.weddingId) {
        req.coupleTarget = found.doc;
        req.coupleTargetKind = found.kind;
        req.params.id = String(found.weddingId);
        return next();
      }
      if (found === null) return res.status(404).send({ error: "not_found", message: missing });
    }

    // 3 · the caller has exactly one.
    return CheckToken(req, res, async () => {
      try {
        const userId = req.auth && req.auth.user_id;
        // No usable identity: leave `:id` alone and let CoupleAuth send the
        // 401 it would have sent anyway, in the shape the client reads.
        if (!userId || (req.auth && (req.auth.isAdmin || req.auth.isVendor))) return next();

        let weddingIds = await weddingsFor(userId);
        if (narrow) weddingIds = await narrow(weddingIds, targetId);

        if (!weddingIds.length) return res.status(404).send({ error: "not_found", message: missing });
        if (weddingIds.length > 1) {
          return res.status(409).send({
            error: "wedding_ambiguous",
            message: "You are on more than one wedding — tell us which by sending weddingId.",
            weddingIds,
          });
        }
        req.params.id = weddingIds[0];
        return next();
      } catch (error) {
        return res.status(500).send({ error: "server_error", message: "We could not open that — please retry." });
      }
    });
  } catch (error) {
    return res.status(500).send({ error: "server_error", message: "We could not open that — please retry." });
  }
};

/* ── loaders ──────────────────────────────────────────────────────────────── */

/**
 * `POST /decor/:id/*` — the finished client calls these with the WEDDING id
 * (`api.heartDecor(weddingId, …)`), and § 06.2 reads `:id` as a décor draft.
 * Both are served: an Event id is the wedding, and an eventDays[] subdocument
 * id is one day of it. `kind` tells the controller which it was, so a per-day
 * tier and a wedding-wide one are the same route and not two.
 */
const loadDecorTarget = async (id) => {
  const wedding = await Event.findById(id, { _id: 1 }).lean();
  if (wedding) return { doc: { weddingId: String(wedding._id), dayId: null }, weddingId: wedding._id, kind: "wedding" };
  const owner = await Event.findOne({ "eventDays._id": id }, { _id: 1 }).lean();
  if (owner) return { doc: { weddingId: String(owner._id), dayId: String(id) }, weddingId: owner._id, kind: "day" };
  return null;
};

/**
 * `POST /makeup-bids/:id/accept` — a BiddingBid knows its round, and a round
 * posted from this app is pointed at by the wedding. When it was raised through
 * the older vendor flow there is no pointer, and FromCaller falls through to
 * the caller's own weddings (the client sends `{ weddingId }` anyway).
 */
const loadBid = async (id) => {
  const bid = await BiddingBid.findById(id, { bidding: 1 }).lean();
  if (!bid) return null;
  const event = await Event.findOne({ "coupleApp.makeup.bidding": bid.bidding }, { _id: 1 }).lean();
  if (event) return { doc: bid, weddingId: event._id, kind: "bid" };
  const round = await Bidding.findById(bid.bidding, { user: 1 }).lean();
  if (!round) return null;
  const owned = await Event.find({ user: round.user }, { _id: 1 }).limit(2).lean();
  if (owned.length === 1) return { doc: bid, weddingId: owned[0]._id, kind: "bid" };
  return undefined; // found the bid, could not place it — fall through to the caller
};

/* ── wedding-scoped routes ────────────────────────────────────────────────── */

/* Venues — § 3.2.1. The concierge shortlist, its holds and its chat. */
router.get("/:id/venues", CoupleAuth, RequireSection("decor", "view"), planning.GetVenues);

/* Décor — § 3.2.2. */
router.get("/:id/decor", CoupleAuth, RequireSection("decor", "view"), planning.GetDecor);

/* Budget — § 3.2.3. The estimate is an EDIT: it stores the answers behind the
   number the team will open. */
router.get("/:id/budget", CoupleAuth, RequireSection("decor", "view"), planning.GetBudget);
router.post("/:id/budget/estimate", CoupleAuth, RequireSection("decor", "edit"), planning.EstimateBudget);
router.put("/:id/budget/target", CoupleAuth, RequireSection("decor", "edit"), planning.SetBudgetTarget);

/* The Wedding Store — § 3.3. The catalogue is registered before the draft
   paths for readability; they are distinct paths, not shadowed ones. */
router.get("/:id/store/catalogue", CoupleAuth, RequireSection("decor", "view"), planning.GetCatalogue);
router.get("/:id/store/draft", CoupleAuth, RequireSection("decor", "view"), planning.GetStoreDraft);
router.post("/:id/store/draft/items", CoupleAuth, RequireSection("decor", "edit"), planning.AddStoreItem);
router.delete(
  "/:id/store/draft/items/:itemId",
  CoupleAuth,
  RequireSection("decor", "edit"),
  planning.RemoveStoreItem
);
router.post("/:id/store/draft/send", CoupleAuth, RequireSection("decor", "edit"), planning.SendStoreDraft);

/* Makeup — § 3.5. */
router.get("/:id/makeup", CoupleAuth, RequireSection("decor", "view"), planning.GetMakeup);
router.put("/:id/makeup/brief", CoupleAuth, RequireSection("decor", "edit"), planning.SaveMakeupBrief);

/* ── child-resource routes (no wedding id in the URL) ─────────────────────── */

const VENUE_MISSING = "We could not find that venue.";
const DECOR_MISSING = "We could not find that décor.";
const BID_MISSING = "We could not find that bid.";

/* Venues. `GET /venues` — the MARKETPLACE — is deliberately NOT here: it
   already exists on this server (routes/venue.js → controllers/venue.getVenues,
   mounted at /venues well above this router), the couple app's client
   normalises its document shape in lib/plan/normalise.js, and a second browse
   endpoint would be two answers to "which venues does Wedsy work with". */
items.post(
  "/venues/:id/react",
  FromCaller({ narrow: narrowByVenue, missing: VENUE_MISSING }),
  CoupleAuth,
  RequireSection("decor", "edit"),
  planning.ReactVenue
);
items.post(
  "/venues/:id/offer/accept",
  FromCaller({ narrow: narrowByVenue, missing: VENUE_MISSING }),
  CoupleAuth,
  RequireSection("decor", "edit"),
  planning.AcceptVenueOffer
);
items.post(
  "/venues/:id/enquire",
  FromCaller({ narrow: narrowByVenue, missing: VENUE_MISSING }),
  CoupleAuth,
  RequireSection("decor", "edit"),
  planning.EnquireVenue
);

/* Décor. FromDocument is the people milestone's, imported and not rewritten. */
items.post(
  "/decor/:id/heart",
  FromDocument(loadDecorTarget, DECOR_MISSING),
  CoupleAuth,
  RequireSection("decor", "edit"),
  planning.HeartDecor
);
items.post(
  "/decor/:id/select-tier",
  FromDocument(loadDecorTarget, DECOR_MISSING),
  CoupleAuth,
  RequireSection("decor", "edit"),
  planning.SelectTier
);
/* THE IRREVERSIBLE ONE (§ 06.2). The hold-confirm the ceremony produces is
   checked in CouplePlanningRules.finaliseFrom, and the money it commits goes
   through CoupleDecorFinaliseService — never around it. */
items.post(
  "/decor/:id/finalise",
  FromDocument(loadDecorTarget, DECOR_MISSING),
  CoupleAuth,
  RequireSection("decor", "edit"),
  planning.FinaliseDecor
);

/* Makeup. Accepting also writes the retainer into the payment schedule, down
   the same finalise path — see services/CoupleMakeupService.acceptBid. */
items.post(
  "/makeup-bids/:id/accept",
  FromCaller({ load: loadBid, missing: BID_MISSING }),
  CoupleAuth,
  RequireSection("decor", "edit"),
  planning.AcceptBid
);

router.use("/", items);

module.exports = router;
// routes/router.js already mounts this at the root, so the client's own paths
// (`/venues/:id/react`, `/decor/:id/finalise`, `/makeup-bids/:id/accept`) are
// served rather than answering at `/wedding/venues/:id/react`.
module.exports.itemRoutes = items;
// Exported for tests/couple-planning-permissions.test.js, which runs the REAL
// gates against a fabricated req.couple with no database at all.
module.exports.FromCaller = FromCaller;
module.exports.loadDecorTarget = loadDecorTarget;
module.exports.loadBid = loadBid;
module.exports.weddingsFor = weddingsFor;
module.exports.narrowByVenue = narrowByVenue;
