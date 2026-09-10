/* MAKEUP & BEAUTY (§ 3.5) — the couple posts a brief, artists bid, the couple
 * accepts one.
 *
 * ── THIS BIDDING SYSTEM ALREADY EXISTS ─────────────────────────────────────
 * models/Bidding, models/BiddingBid and models/BiddingBooking are the vendor
 * marketplace's own records, driven today by routes/bidding.js and worked by
 * the vendor app. § 06.2 never described a makeup model at all, and the four
 * contracts the finished client names (`GET /wedding/:id/makeup`,
 * `PUT …/makeup/brief`, `POST /makeup-bids/:id/accept`, and the trial) are a
 * COUPLE-FACING READ AND WRITE OVER THOSE ROWS. Nothing here opens a second
 * bidding system:
 *
 *   the round     one Bidding document, `requirements.category = "makeup"`,
 *                 owned by the couple's own User. The brief the couple posts
 *                 is its `events`, which the model already types as [Object].
 *   the bids      BiddingBid rows, exactly as the vendor app writes them, with
 *                 the SAME `status.userAccepted` / `status.userRejected` flags
 *                 routes/bidding.js sets.
 *   the trial     a BiddingBooking, the model already meant for "this couple
 *                 booked this vendor".
 *
 * Event.coupleApp.makeup holds only the POINTERS at those three, so the couple
 * app can find its round without a second copy of it.
 *
 * ── ACCEPTING A BID COMMITS MONEY ──────────────────────────────────────────
 * And it does it down the SAME path as the décor finalise:
 * CoupleDecorFinaliseService.plan() decides the budget line, the schedule and
 * the source keys; CoupleScheduleService.apply() upserts them on the unique
 * { weddingId, sourceKey } pair. The RETAINER is the first row of that
 * schedule — 25% at +7 days, which is the product decision that already lives
 * in one place. There is no bespoke retainer arithmetic in this file, and
 * accepting twice cannot double the schedule.
 */

const mongoose = require("mongoose");
const Event = require("../models/Event");
const Bidding = require("../models/Bidding");
const BiddingBid = require("../models/BiddingBid");
const BiddingBooking = require("../models/BiddingBooking");
const Vendor = require("../models/Vendor");
const VendorReview = require("../models/VendorReview");

const CoupleWeddingService = require("./CoupleWeddingService");
const finaliseService = require("./CoupleDecorFinaliseService");
const scheduleService = require("./CoupleScheduleService");
const activityService = require("./CoupleActivityService");
const peopleRules = require("./CouplePeopleRules");
const rules = require("./CouplePlanningRules");

const CATEGORY = "Makeup";
const ARTIST_LIMIT = 24;

/** The function keys this wedding has — § 06.3 "Events: defined once". */
const eventKeysOf = (event) =>
  ((event && event.eventDays) || [])
    .map((day) => CoupleWeddingService.dayKey(day && day.name))
    .filter(Boolean);

const makeupOf = (event) => (event && event.coupleApp && event.coupleApp.makeup) || {};

/** The wedding's round, or null. Never created by a read. */
const roundFor = async (event) => {
  const pointer = makeupOf(event).bidding;
  if (pointer) return Bidding.findById(pointer).lean();
  // A couple who raised a bidding round through the older vendor flow already
  // has one; find it rather than opening a second.
  if (!event.user) return null;
  return Bidding.findOne({ user: event.user, "requirements.category": CATEGORY })
    .sort({ createdAt: -1 })
    .lean();
};

/** The brief as it is stored on the Bidding document. */
const briefOf = (round) => {
  const events = (round && round.events) || [];
  const brief = events.find((row) => row && row.kind === "makeup-brief") || events[0] || null;
  if (!brief) return null;
  return {
    id: String(round._id),
    date: brief.date || "",
    functions: brief.functions || [],
    budgetLow: rules.money(brief.budgetLow),
    budgetHigh: rules.money(brief.budgetHigh),
    people: Number(brief.people) || 1,
    looks: brief.looks || "",
    postedAt: round.createdAt || null,
    open: Boolean(round.status && round.status.active && !round.status.finalized),
  };
};

/** ObjectId casting kept in one place so the aggregate below stays readable. */
const vendorObjectIds = (ids) => ids.map((id) => new mongoose.Types.ObjectId(String(id)));

/** Vendors, review counts and the bids, resolved together. */
const withVendors = async (bids) => {
  const vendorIds = [...new Set(bids.map((bid) => String(bid.vendor)).filter(Boolean))];
  if (!vendorIds.length) return { byId: new Map(), reviews: new Map() };
  const [vendors, reviewCounts] = await Promise.all([
    Vendor.find(
      { _id: { $in: vendorIds } },
      { name: 1, businessName: 1, rating: 1, gallery: 1, businessAddress: 1, prices: 1, speciality: 1, other: 1 }
    ).lean(),
    VendorReview.aggregate([
      { $match: { vendor: { $in: vendorObjectIds(vendorIds) } } },
      { $group: { _id: "$vendor", count: { $sum: 1 } } },
    ]),
  ]);
  return {
    byId: new Map(vendors.map((vendor) => [String(vendor._id), vendor])),
    reviews: new Map(reviewCounts.map((row) => [String(row._id), row.count])),
  };
};

/** A Vendor → the browsable artist card. */
const shapeArtist = (vendor, reviewCount, didBid) => {
  const prices = [vendor.prices && vendor.prices.bridal, vendor.prices && vendor.prices.party, vendor.prices && vendor.prices.groom]
    .map(rules.money)
    .filter(Boolean);
  return {
    id: String(vendor._id),
    name: vendor.businessName || vendor.name || "",
    avatar: (vendor.gallery && vendor.gallery.coverPhoto) || null,
    rating: Number(vendor.rating) || 0,
    reviews: Number(reviewCount || 0),
    from: prices.length ? Math.min.apply(null, prices) : 0,
    tag: vendor.speciality || "",
    city: (vendor.businessAddress && vendor.businessAddress.city) || "",
    bid: Boolean(didBid),
  };
};

/** The trial, as the BiddingBooking holds it. */
const shapeTrial = (booking, vendor) => {
  if (!booking) return null;
  const row = ((booking.events || []).find((event) => event && event.kind === "trial")) || {};
  return {
    id: String(booking._id),
    bidId: row.bidId ? String(row.bidId) : null,
    artistId: String(booking.vendor || ""),
    name: (vendor && (vendor.businessName || vendor.name)) || "",
    // HONESTLY NULL. The couple accepts a bid; nobody has picked a date, a time
    // or a studio yet, and inventing one would put an appointment in their
    // calendar that no artist knows about.
    date: row.date || null,
    startTime: row.startTime || null,
    place: row.place || "",
    status: row.status || "requested",
    note: row.note || "",
  };
};

/* ── the read ─────────────────────────────────────────────────────────────── */

/** GET /wedding/:id/makeup — gated `decor / view`. */
const get = async (couple) => {
  const event = couple.event;
  const round = await roundFor(event);

  const bids = round
    ? await BiddingBid.find({ bidding: round._id, bid: { $gt: 0 } }).sort({ createdAt: 1 }).lean()
    : [];
  const { byId, reviews } = await withVendors(bids);

  const bidderIds = new Set(bids.map((bid) => String(bid.vendor)));
  /* THE ARTISTS TO BROWSE, "beyond the four who bid" (§ 3.5).
   *
   * Deliberately NOT filtered on `Vendor.category`. models/Vendor IS the
   * makeup-and-beauty roster on this server — its price fields are bridal,
   * party and groom, its profile block is `other.makeupProducts`,
   * Payment.paymentFor's enum carries "makeup-and-beauty" and the review share
   * link is /makeup-and-beauty/artists/:id — and `category` is free text with
   * no enum and no agreed vocabulary. Filtering on a guessed value would show
   * the couple an empty marketplace, which is worse than showing them the
   * roster. Verified, visible and not deleted are the filters that mean
   * something, and they are the same three controllers/bidding.CreateNew uses. */
  const artistRows = await Vendor.find(
    {
      profileVerified: true,
      profileVisibility: true,
      blocked: { $ne: true },
      deleted: { $ne: true },
    },
    { name: 1, businessName: 1, rating: 1, gallery: 1, businessAddress: 1, prices: 1, speciality: 1 }
  )
    .sort({ rating: -1 })
    .limit(ARTIST_LIMIT)
    .lean();

  const pointers = makeupOf(event);
  const booking = pointers.trialBooking ? await BiddingBooking.findById(pointers.trialBooking).lean() : null;

  return {
    brief: briefOf(round),
    bids: bids.map((bid) => rules.shapeBid(bid, byId.get(String(bid.vendor)), reviews.get(String(bid.vendor)))),
    trial: shapeTrial(booking, booking ? byId.get(String(booking.vendor)) : null),
    artists: artistRows.map((vendor) => shapeArtist(vendor, reviews.get(String(vendor._id)), bidderIds.has(String(vendor._id)))),
    acceptedBidId: pointers.acceptedBid ? String(pointers.acceptedBid) : null,
  };
};

/* ── the writes ───────────────────────────────────────────────────────────── */

const note = (couple, { action, objectId, summary }) => {
  const actor = peopleRules.actorOf(couple);
  return activityService.record({
    weddingId: couple.weddingId,
    actorType: actor.type,
    actor: { id: actor.id, name: actor.name },
    action,
    objectType: "makeup",
    objectId,
    summary,
  });
};

/**
 * PUT /wedding/:id/makeup/brief — gated `decor / edit`.
 *
 * Creates the round on first save, updates it after. The BRIEF IS THE ROUND:
 * it is written onto the Bidding document the vendor app already reads, not
 * into a couple-app copy of it.
 *
 * Note what is NOT done here: the fan-out that creates a BiddingBid row for
 * every eligible vendor, and the two messages it sends. That whole path lives
 * in controllers/bidding.CreateNew and it SENDS NOTIFICATIONS — which this
 * milestone may not add (see the marked comment below). A brief saved here is
 * therefore live and visible, and the fan-out is one call away once the
 * Notification System spec has been read.
 */
const saveBrief = async (couple, body) => {
  const event = couple.event;
  const brief = rules.briefFrom(body, eventKeysOf(event));
  const now = new Date();
  const row = { kind: "makeup-brief", ...brief, at: now };

  let round = await roundFor(event);
  if (round) {
    if (round.status && round.status.finalized) {
      throw rules.fail(409, "round_closed", "You have already booked an artist for this wedding.");
    }
    await Bidding.updateOne(
      { _id: round._id },
      { $set: { events: [row], "requirements.category": CATEGORY } }
    );
  } else {
    if (!event.user) {
      throw rules.fail(409, "no_account", "This wedding has no account we can post a brief from yet.");
    }
    round = await Bidding.create({
      user: event.user,
      events: [row],
      requirements: {
        city: (event.coupleApp && event.coupleApp.city) || "",
        gender: "",
        category: CATEGORY,
      },
      status: { active: true, finalized: false, lost: false, completed: false },
    });
  }

  await Event.updateOne(
    { _id: couple.weddingId },
    { $set: { "coupleApp.makeup.bidding": round._id, "coupleApp.makeup.briefAt": now } }
  );

  await note(couple, {
    action: "makeup.brief_posted",
    objectId: round._id,
    summary: "Posted a makeup brief for artists to bid on",
  });

  /* ⛏ NOTIFICATION TRIGGER — NOT ADDED (project hard rule: triggers only,
   * through services/NotificationService.js, WhatsApp via the Meta Cloud API,
   * never Aisensy, and only after reading the Notification System spec in
   * Notion). The moment: a brief is posted and eligible artists should hear
   * about it. The triggers ALREADY EXIST on the vendor path and are the ones to
   * reuse rather than invent — `MUA_BID_REQS` to each eligible vendor and
   * `cust_bidreqs_send` back to the couple, both fired today by
   * controllers/bidding.CreateNew. Wiring this brief into that fan-out is the
   * next piece of work; nothing here sends anything. */

  return { ok: true, brief: briefOf({ ...round, _id: round._id, events: [row], status: round.status || {} }) };
};

/**
 * POST /makeup-bids/:id/accept — gated `decor / edit`.
 *
 * Three things happen, and the third is the one that matters most:
 *
 *   1. THE WINNER is marked `status.userAccepted` — the SAME flag
 *      routes/bidding.js sets, so the vendor app sees an accepted bid exactly
 *      as it does today.
 *   2. EVERY OTHER BID on the round is marked `status.userRejected`, and the
 *      round is closed (`status.finalized`). An artist who lost must be told
 *      by the record, not by silence; and a round left open would keep taking
 *      bids on a wedding that is booked.
 *   3. THE RETAINER GOES INTO THE PAYMENT SCHEDULE, down the SAME path as the
 *      décor finalise (CoupleDecorFinaliseService.plan → CoupleScheduleService
 *      .apply). Its first row IS the retainer. No arithmetic here.
 *
 * Idempotent: accepting the same bid twice returns `alreadyAccepted: true` as
 * a VALUE. Accepting a DIFFERENT bid once one is accepted is a 409 — that is
 * not a double tap, it is changing an agreement an artist has been given.
 */
const acceptBid = async (couple, bidId, now = new Date()) => {
  const event = couple.event;
  const bid = await BiddingBid.findById(bidId).lean();
  if (!bid) throw rules.notFound("We could not find that bid.");

  const round = await Bidding.findById(bid.bidding).lean();
  const userIds = [String(event.user || "")].concat(
    ((event.coupleApp && event.coupleApp.partners) || []).map((partner) => String(partner.user || ""))
  );
  if (!round || userIds.indexOf(String(round.user)) === -1) {
    // The bid exists and is not on this wedding's round. 404, not 403: a
    // stranger must not learn which bid ids are real.
    throw rules.notFound("We could not find that bid.");
  }

  const bids = await BiddingBid.find({ bidding: round._id }).lean();
  const decision = rules.acceptance(bids, bidId);
  if (!decision.ok) {
    if (decision.reason === "not_found") throw rules.notFound("We could not find that bid.");
    throw rules.fail(409, "bid_already_accepted", "You have already booked an artist for this wedding.", {
      bidId: decision.acceptedId,
    });
  }

  const vendor = await Vendor.findById(bid.vendor, { name: 1, businessName: 1 }).lean();
  const artist = (vendor && (vendor.businessName || vendor.name)) || "your artist";

  if (!decision.alreadyAccepted) {
    await BiddingBid.updateOne({ _id: bid._id }, { $set: { "status.userAccepted": true, "status.userRejected": false } });
    if (decision.losers.length) {
      await BiddingBid.updateMany(
        { _id: { $in: decision.losers } },
        { $set: { "status.userRejected": true, "status.userAccepted": false } }
      );
    }
    await Bidding.updateOne(
      { _id: round._id },
      { $set: { "status.finalized": true, "status.active": false } }
    );
  }

  /* THE MONEY — § 06.3 invariant 3's path, reused. plan() decides the budget
     line, the schedule and the source keys; the first row of that schedule is
     the retainer. `dayId` is the bid, so the keys are stable across retries and
     a second accept lands on the same rows. */
  const planned = finaliseService.plan({
    event,
    dayId: `makeup:${String(bid._id)}`,
    amount: rules.money(bid.bid),
    label: `Makeup — ${artist}`,
    vendor: artist,
    now,
  });
  const applied = await scheduleService.apply({
    planned,
    weddingId: couple.weddingId,
    userId: event.user || couple.userId,
    source: "makeup",
    ref: "",
  });

  /* THE TRIAL. A BiddingBooking — the model that already means "this couple
     booked this vendor". It is created as REQUESTED with no date: § 3.5's trial
     is a real appointment and neither side has picked a time yet. */
  const pointers = makeupOf(event);
  let bookingId = pointers.trialBooking || null;
  if (!bookingId) {
    const booking = await BiddingBooking.create({
      user: event.user || couple.userId,
      vendor: bid.vendor,
      events: [
        {
          kind: "trial",
          bidId: String(bid._id),
          biddingId: String(round._id),
          status: "requested",
          date: null,
          startTime: null,
          place: "",
          note: "",
          at: now,
        },
      ],
    });
    bookingId = booking._id;
  }

  await Event.updateOne(
    { _id: couple.weddingId },
    {
      $set: {
        "coupleApp.makeup.bidding": round._id,
        "coupleApp.makeup.acceptedBid": bid._id,
        "coupleApp.makeup.acceptedAt": now,
        "coupleApp.makeup.trialBooking": bookingId,
      },
    }
  );

  if (!decision.alreadyAccepted) {
    await note(couple, {
      action: "makeup.bid_accepted",
      objectId: bid._id,
      summary: `Booked ${artist} for the wedding`,
    });
  }

  /* ⛏ NOTIFICATION TRIGGER — NOT ADDED (project hard rule: triggers only,
   * through services/NotificationService.js, WhatsApp via the Meta Cloud API,
   * never Aisensy, and only after reading the Notification System spec in
   * Notion). The moment: a bid is accepted. Two triggers ALREADY EXIST on the
   * vendor path and are the ones to reuse rather than invent —
   * `mua_bid_accept` to the winning artist and `cx_bid_cnfrm` back to the
   * couple, both fired today by controllers/bidding.UserAcceptBiddingBid. A
   * third, for the artists who LOST, does not exist yet and should be decided
   * with the spec in hand: silence is what they get today. */

  return {
    ok: true,
    alreadyAccepted: decision.alreadyAccepted,
    bidId: String(bid._id),
    artistId: String(bid.vendor),
    artist,
    amount: rules.money(bid.bid),
    rejected: decision.losers.length,
    committed: applied.committed,
    scheduleRows: applied.rows,
    // The FIRST row of the shared schedule is the retainer (§ 06.3's 25% at
    // +7 days), so the couple can be told what falls due and when.
    retainer: planned.scheduleRows[0]
      ? { amount: planned.scheduleRows[0].amount, dueDate: planned.scheduleRows[0].dueDate }
      : null,
    trialId: bookingId ? String(bookingId) : null,
    atomic: applied.atomic,
  };
};

module.exports = { get, saveBrief, acceptBid, roundFor, briefOf, shapeArtist, shapeTrial, eventKeysOf };
