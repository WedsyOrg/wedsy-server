/* VENUES — the concierge shortlist and its chat (§ 3.2.1, § 06.2).
 *
 * ── EVERY RECORD HERE ALREADY EXISTED ──────────────────────────────────────
 * Nothing in this file opens a venue system. The five things the screen shows
 * are five records the venue team already keeps:
 *
 *   the shortlist     models/VenueShortlist  — keyed by crmEnquiryId, which is
 *                     Event.leadId as a STRING (a binding decision recorded on
 *                     the model; this app reaches it and must not re-key it)
 *   the reactions     VenueShortlist.items[].reaction — the SAME field the
 *                     venue team reads. The couple's Love/Maybe/Pass is mapped
 *                     onto its "love"/"maybe"/"no" at one seam
 *                     (CouplePlanningRules.reactionToStored) and nowhere else.
 *   the holds         models/VenueHold — a real approved hold with a real
 *                     expiry, never a date this app invented
 *   the thread        models/VenueConversation + models/VenueMessage, which
 *                     already carry senderType couple | venue | wedsy
 *   the offer         a VenueMessage with messageType "offer" and its
 *                     structured `offer` payload
 *
 * The couple app is a READER of all five and a writer of exactly two things:
 * the reaction, and the fact that an offer was accepted.
 *
 * ── WHAT A WEDDING WITH NO SHORTLIST GETS ──────────────────────────────────
 * An empty shortlist, not an invented one. A couple whose planner has not sent
 * options yet is in § 3.2.2's "holding" state, and `POST /venues/:id/react`
 * refuses with a 404 that says so — a reaction with nowhere to be written is a
 * reaction the venue team will never read, and storing it in a second place
 * would be the parallel record this whole file exists to avoid.
 */

const Event = require("../models/Event");
const Venue = require("../models/Venue");
const VenueShortlist = require("../models/VenueShortlist");
const VenueHold = require("../models/VenueHold");
const VenueConversation = require("../models/VenueConversation");
const VenueMessage = require("../models/VenueMessage");
const Admin = require("../models/Admin");

const rules = require("./CouplePlanningRules");
const activityService = require("./CoupleActivityService");
const peopleRules = require("./CouplePeopleRules");
const { isId } = require("../utils/objectId");

/** Every User account on this wedding — the ids a VenueConversation is keyed by. */
const userIdsOf = (event) => {
  const ids = [];
  if (event && event.user) ids.push(String(event.user));
  ((event && event.coupleApp && event.coupleApp.partners) || []).forEach((partner) => {
    if (partner && partner.user) ids.push(String(partner.user));
  });
  return [...new Set(ids)].filter(isId);
};

/** The wedding's shortlist, or null. Resolved through Event.leadId, as a string. */
const shortlistFor = async (event) => {
  if (!event || !event.leadId) return null;
  return VenueShortlist.findOne({ crmEnquiryId: String(event.leadId) }).lean();
};

/** Fire-and-safe feed row. A feed that cannot be written never fails a write. */
const note = (couple, { action, objectId, summary }) => {
  const actor = peopleRules.actorOf(couple);
  return activityService.record({
    weddingId: couple.weddingId,
    actorType: actor.type,
    actor: { id: actor.id, name: actor.name },
    action,
    objectType: "venue",
    objectId,
    summary,
  });
};

/**
 * GET /wedding/:id/venues — shortlist + holds + messages + the live offer.
 * Gated `decor / view`.
 */
const get = async (couple) => {
  const event = couple.event;
  const shortlist = await shortlistFor(event);
  const items = (shortlist && shortlist.items) || [];
  const venueIds = items.map((item) => item.venue).filter(Boolean);

  if (!venueIds.length) {
    return { shortlist: [], holds: [], messages: [], offer: null, hasShortlist: Boolean(shortlist) };
  }

  const userIds = userIdsOf(event);
  const [venues, holds, conversations] = await Promise.all([
    Venue.find(
      { _id: { $in: venueIds } },
      { name: 1, locality: 1, zone: 1, tagline: 1, spaces: 1, "pricing.tiers": 1, coverPhoto: 1, googlePhotos: 1 }
    ).lean(),
    VenueHold.find({ venue: { $in: venueIds }, status: { $in: ["requested", "approved"] } })
      .sort({ expiresAt: 1 })
      .lean(),
    userIds.length
      ? VenueConversation.find({ venueId: { $in: venueIds }, userId: { $in: userIds } }).lean()
      : [],
  ]);

  const venueById = new Map(venues.map((venue) => [String(venue._id), venue]));
  // The hold that is actually holding this venue's date — approved beats
  // requested, and the one that expires soonest is the one under pressure.
  const holdByVenue = new Map();
  holds.forEach((hold) => {
    const key = String(hold.venue);
    const current = holdByVenue.get(key);
    if (!current) holdByVenue.set(key, hold);
    else if (current.status !== "approved" && hold.status === "approved") holdByVenue.set(key, hold);
  });

  const shaped = items.map((item) =>
    rules.shapeShortlistVenue(venueById.get(String(item.venue)), item, holdByVenue.get(String(item.venue)))
  );

  /* The thread. Wedsy-side messages targeted `venue_only` are an internal
     intervention and are NOT the couple's to read — that is what the field is
     for, and it is filtered in the query rather than after it. */
  let messages = [];
  let offerMessage = null;
  if (conversations.length) {
    const rows = await VenueMessage.find({
      conversationId: { $in: conversations.map((conversation) => conversation._id) },
      target: { $ne: "venue_only" },
    })
      .sort({ createdAt: 1 })
      .limit(200)
      .lean();

    const conversationVenue = new Map(
      conversations.map((conversation) => [String(conversation._id), String(conversation.venueId)])
    );
    const adminIds = rows
      .filter((row) => row.senderType === "wedsy" && isId(row.senderId))
      .map((row) => String(row.senderId));
    const admins = adminIds.length
      ? await Admin.find({ _id: { $in: [...new Set(adminIds)] } }, { name: 1 }).lean()
      : [];
    const adminName = new Map(admins.map((admin) => [String(admin._id), admin.name || ""]));

    messages = rows.map((row) => {
      const venueId = conversationVenue.get(String(row.conversationId));
      const venue = venueById.get(String(venueId));
      return rules.shapeVenueMessage(row, {
        team: adminName.get(String(row.senderId)) || "Your Wedsy planner",
        venue: (venue && venue.name) || "",
        couple: "You",
      });
    });

    // The live offer: the most recent one that has not lapsed.
    const now = Date.now();
    offerMessage =
      rows
        .filter((row) => row.messageType === "offer")
        .filter((row) => !row.offer || !row.offer.validUntil || new Date(row.offer.validUntil).getTime() >= now)
        .slice(-1)[0] || null;
    if (offerMessage) {
      offerMessage.venueId = conversationVenue.get(String(offerMessage.conversationId));
    }
  }

  const accepted = (event.coupleApp && event.coupleApp.venues && event.coupleApp.venues.acceptedOffer) || {};

  return {
    shortlist: shaped,
    holds: holds.map((hold) => ({
      id: String(hold._id),
      venueId: String(hold.venue),
      venueName: (venueById.get(String(hold.venue)) || {}).name || "",
      dates: hold.dates || [],
      status: hold.status,
      expiresAt: hold.expiresAt || null,
    })),
    messages,
    offer: offerMessage
      ? {
          ...rules.shapeOffer(offerMessage, venueById.get(String(offerMessage.venueId))),
          accepted: accepted.message ? String(accepted.message) === String(offerMessage._id) : false,
        }
      : null,
    acceptedOfferId: accepted.message ? String(accepted.message) : null,
    hasShortlist: true,
  };
};

/**
 * POST /venues/:id/react { reaction } — gated `decor / edit`.
 *
 * Writes the venue team's OWN field. The `pass` → `no` mapping is
 * CouplePlanningRules', not this file's, and the status moves to "reacted" so
 * the planner's board reads the same thing the couple sees.
 */
const react = async (couple, venueId, body) => {
  const stored = rules.reactionFrom(body);
  const event = couple.event;
  const shortlist = await shortlistFor(event);
  if (!shortlist) {
    throw rules.notFound("Your planner has not sent you a shortlist yet.");
  }
  const item = (shortlist.items || []).find((row) => String(row.venue) === String(venueId));
  if (!item) throw rules.notFound("That venue is not on your shortlist.");

  await VenueShortlist.updateOne(
    { _id: shortlist._id, "items._id": item._id },
    { $set: { "items.$.reaction": stored, "items.$.status": "reacted" } }
  );

  const venue = await Venue.findById(venueId, { name: 1 }).lean();
  await note(couple, {
    action: "venue.reaction",
    objectId: venueId,
    summary: `${rules.reactionFromStored(stored) === "pass" ? "Passed on" : rules.reactionFromStored(stored) === "love" ? "Loved" : "Might like"} ${(venue && venue.name) || "a venue"}`,
  });

  return { ok: true, venueId: String(venueId), reaction: rules.reactionFromStored(stored) };
};

/**
 * POST /venues/:id/offer/accept { offerId } — gated `decor / edit`.
 *
 * IDEMPOTENT, and the second answer equals the first: `alreadyAccepted` is a
 * value, exactly as `alreadyFinalised` is on the décor finalise. Accepting a
 * DIFFERENT offer once one is accepted is refused — that is not a double tap.
 *
 * The acceptance is written twice on purpose, and neither is a copy of the
 * other: `Event.coupleApp.venues.acceptedOffer` is the couple's record of what
 * they agreed to, and a couple-side VenueMessage in the SAME thread is how the
 * venue and the planner find out. Without the second, a couple could accept an
 * offer that nobody at the venue ever hears about.
 */
const acceptOffer = async (couple, venueId, body) => {
  const offerId = rules.text(body && (body.offerId || body.id), 40);
  if (!isId(offerId)) {
    throw rules.validation({ offerId: "We could not tell which offer." }, "No offer was named.");
  }

  const message = await VenueMessage.findById(offerId).lean();
  if (!message || message.messageType !== "offer") throw rules.notFound("We could not find that offer.");

  const conversation = await VenueConversation.findById(message.conversationId).lean();
  const userIds = userIdsOf(couple.event);
  if (
    !conversation ||
    String(conversation.venueId) !== String(venueId) ||
    userIds.indexOf(String(conversation.userId)) === -1
  ) {
    // The offer exists and is not this couple's. 404, not 403: a stranger must
    // not learn which offer ids are real.
    throw rules.notFound("We could not find that offer.");
  }

  const current =
    (couple.event.coupleApp && couple.event.coupleApp.venues && couple.event.coupleApp.venues.acceptedOffer) || {};
  if (current.message && String(current.message) === String(offerId)) {
    return { ok: true, alreadyAccepted: true, offerId: String(offerId), venueId: String(venueId) };
  }
  if (current.message) {
    throw rules.fail(409, "offer_already_accepted", "You have already accepted an offer for this wedding.", {
      offerId: String(current.message),
    });
  }

  const now = new Date();
  await Event.updateOne(
    { _id: couple.weddingId },
    {
      $set: {
        "coupleApp.venues.acceptedOffer": { message: offerId, venue: venueId, at: now },
      },
    }
  );

  // Into the venue's own thread, as the couple, so the desk sees a yes.
  await VenueMessage.create({
    conversationId: conversation._id,
    senderId: couple.userId,
    senderType: "couple",
    messageType: "text",
    content: { text: `We accept: ${(message.offer && message.offer.title) || "your offer"}.` },
  });
  await VenueConversation.updateOne(
    { _id: conversation._id },
    { $set: { lastMessageAt: now, lastCoupleMessageAt: now }, $inc: { unreadCountVenue: 1 } }
  );

  await note(couple, {
    action: "venue.offer_accepted",
    objectId: venueId,
    summary: `Accepted ${(message.offer && message.offer.title) || "an offer"}`,
  });

  /* ⛏ NOTIFICATION TRIGGER — NOT ADDED (project hard rule: triggers only,
   * through services/NotificationService.js, WhatsApp via the Meta Cloud API,
   * never Aisensy, and only after reading the Notification System spec in
   * Notion). The moment: the couple accepts a venue offer. The trigger this
   * wants is `couple_venue_offer_accepted`, to the venue desk and the lead
   * planner. The in-thread message above is the in-app half and stands alone. */

  return { ok: true, alreadyAccepted: false, offerId: String(offerId), venueId: String(venueId), at: now };
};

module.exports = { get, react, acceptOffer, shortlistFor, userIdsOf };
