/* COUPLE APP — PLANNING RULES. PURE.
 *
 * Shaping, validation, refusals and the small decisions that must be the same
 * on every path: which reaction word the venue team stores, which catalogue
 * product a couple may put in their draft, which bid wins and which lose.
 *
 * No mongoose, no express, no clock (every function that needs "now" takes it
 * as an argument). Everything here is unit-tested with object literals.
 *
 * The refusal bodies are the foundation's, unchanged (docs § 3):
 *   401 { error: "unauthenticated", message }
 *   403 { error: "forbidden", section, required, held, message }
 *   404 { error: "not_found", message }
 *   409 { error: <code>, … }
 *   422 { error: "validation", fields: { … } }
 */

const { EVENT_KEY } = require("../utils/coupleEnums");

/** The one error shape every planning service throws. */
const fail = (status, code, message, extra) =>
  Object.assign(new Error(message), { status, code, extra: extra || null });

const validation = (fields, message) =>
  fail(422, "validation", message || "Please check the highlighted fields.", { fields });

const notFound = (message) => fail(404, "not_found", message);

/** Whole rupees, never negative. A price is a number or it is nothing. */
const money = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

/** A short, safe free-text field. Trimmed, capped, never a path or a script. */
const text = (value, max = 200) => String(value === undefined || value === null ? "" : value).trim().slice(0, max);

/** "Photo booth" → "photo-booth". The one slug rule for catalogue categories. */
const slug = (value) =>
  text(value, 80)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "other";

/** A function key this wedding actually has (§ 06.3 "Events: defined once"). */
const eventKeyOf = (value) => {
  const key = text(value, 40).toLowerCase();
  return EVENT_KEY.indexOf(key) === -1 ? "" : key;
};

/* ── venues ───────────────────────────────────────────────────────────────── */

/**
 * THE REACTION SEAM.
 *
 * The couple app's vocabulary is Love / Maybe / Pass (§ 3.2.1, and the client's
 * REACTIONS list). VenueShortlist.items.reaction — the venue team's own record,
 * which predates this app — stores `"" | "love" | "maybe" | "no"`. "pass" is
 * not in that enum, and writing it would fail validation on a model this
 * milestone must not change.
 *
 * So the mapping lives here, in ONE function each way, and no controller ever
 * writes a reaction word by hand. `docs/couple-app-api.md § 5` flagged exactly
 * this ("note VenueShortlist.items.reaction stores 'no', not 'pass'; map at the
 * seam") — this is the seam.
 */
const REACTIONS = ["love", "maybe", "pass"];

const reactionToStored = (value) => {
  const reaction = text(value, 20).toLowerCase();
  if (reaction === "pass" || reaction === "no") return "no";
  if (reaction === "love" || reaction === "maybe") return reaction;
  return null; // unknown ⇒ refuse, never store a word the enum has no room for
};

const reactionFromStored = (value) => {
  const reaction = text(value, 20).toLowerCase();
  if (reaction === "no") return "pass";
  if (reaction === "love" || reaction === "maybe") return reaction;
  return "";
};

/** The reaction a `POST /venues/:id/react` body carries, or a 422. */
const reactionFrom = (body) => {
  const stored = reactionToStored(body && body.reaction);
  if (!stored) {
    throw validation(
      { reaction: `Choose one of ${REACTIONS.join(", ")}.` },
      "We did not recognise that reaction."
    );
  }
  return stored;
};

/** A Venue document → the shortlist card the venue chat renders (§ 3.2.1). */
const shapeShortlistVenue = (venue, item, hold) => {
  const spaces = (venue && venue.spaces) || [];
  const tiers = (venue && venue.pricing && venue.pricing.tiers) || [];
  const prices = tiers.map((tier) => money(tier && tier.price)).filter(Boolean);
  const photos = []
    .concat((venue && venue.coverPhoto) || [])
    .concat((venue && venue.googlePhotos) || [])
    .concat(spaces.reduce((all, space) => all.concat((space && space.photos) || []), []))
    .filter(Boolean);
  return {
    // THE VENUE's id, because that is what `POST /venues/:id/react` is called
    // with (`api.reactVenue(venue.id, …)`). The shortlist row's own id rides
    // alongside as `itemId` for anything that needs to address the row.
    id: String((venue && venue._id) || ""),
    itemId: String((item && item._id) || ""),
    name: (venue && venue.name) || "",
    area: (venue && (venue.locality || venue.zone)) || "",
    capacity: spaces.reduce((best, space) => Math.max(best, Number((space && space.capacitySeated) || 0)), 0),
    priceLow: prices.length ? Math.min.apply(null, prices) : 0,
    priceHigh: prices.length ? Math.max.apply(null, prices) : 0,
    photo: photos[0] || null,
    // The hold the venue team actually has, not a date this app invented.
    holdUntil: hold && hold.expiresAt ? hold.expiresAt : null,
    // The planner's OWN words about this venue — VenueShortlist.items.notes is
    // where Ravi wrote them. Never the venue's marketing copy.
    note: (item && item.notes) || (venue && venue.tagline) || "",
    reaction: reactionFromStored(item && item.reaction),
    status: (item && item.status) || "shortlisted",
  };
};

/** A VenueMessage → the thread bubble the venue chat renders. */
const shapeVenueMessage = (message, names) => {
  const sender = String((message && message.senderType) || "");
  const from = sender === "wedsy" ? "team" : sender === "venue" ? "venue" : "couple";
  return {
    id: String((message && message._id) || ""),
    from,
    name: (names && names[from]) || "",
    text: (message && message.content && message.content.text) || "",
    at: (message && message.createdAt) || null,
    kind: message && message.messageType === "offer" ? "offer" : undefined,
  };
};

/**
 * A VenueMessage of type "offer" → the structured offer card (§ 3.2.1).
 *
 * HONESTLY PARTIAL. The card the finished screen draws carries `rentalWas`,
 * `rentalNow`, `terms[]` and a site-visit block; `VenueMessage.offer` holds a
 * title, a body and a validUntil, and nothing else. The three missing pieces
 * come back absent rather than invented — a rental figure this server made up
 * is a number the couple would plan around.
 */
const shapeOffer = (message, venue) => {
  if (!message) return null;
  const offer = message.offer || {};
  return {
    id: String(message._id || ""),
    venueId: String((venue && venue._id) || message.venueId || ""),
    venueName: (venue && venue.name) || "",
    title: offer.title || "",
    body: offer.body || (message.content && message.content.text) || "",
    validUntil: offer.validUntil || null,
    at: message.createdAt || null,
  };
};

/* ── décor ────────────────────────────────────────────────────────────────── */

/**
 * `POST /decor/:id/heart { themeId | productId }`.
 *
 * Exactly one of the two, and the id is a CATALOGUE id (a theme or a product
 * in the lookbook), not an ObjectId on this wedding — which is why it is
 * stored as a String and validated for shape rather than cast.
 */
const heartFrom = (body) => {
  const b = body && typeof body === "object" ? body : {};
  const themeId = text(b.themeId, 80);
  const productId = text(b.productId, 80);
  if (themeId && productId) {
    throw validation(
      { themeId: "Send a look or a piece, not both." },
      "We could not tell which one you loved."
    );
  }
  if (!themeId && !productId) {
    throw validation({ themeId: "Tell us which look or piece." }, "Nothing to love there.");
  }
  return {
    kind: themeId ? "theme" : "product",
    ref: themeId || productId,
    event: eventKeyOf(b.event || b.eventKey),
  };
};

/** `POST /decor/:id/select-tier { tier }`. */
const tierFrom = (body) => {
  const tier = text(body && (body.tier || body.tierId), 40);
  if (!tier) throw validation({ tier: "Choose one of the priced tiers." }, "No tier was chosen.");
  return tier;
};

/**
 * `POST /decor/:id/finalise` — THE IRREVERSIBLE ONE (§ 06.2).
 *
 * § 3.2.2's ceremony is a 1.6-second hold (or, for a reader who has asked for
 * less motion, typing FINALISE in full). Both produce ONE request, and what
 * that request carries is the tier being committed and its total:
 *
 *     api.finaliseDecor(weddingId, { tier: activeDraft.id, total: totals.total })
 *
 * So the named tier IS the confirmation this server can check: a finalise with
 * no tier in it did not come from the ceremony, and it is refused. An explicit
 * `confirm: true` is accepted as well, for any caller that starts sending one.
 *
 * `total` is read as a CEILING the couple saw, never as the amount: the
 * committed figure is the one the server computes from the priced draft. A
 * body is not allowed to name what a wedding costs.
 */
const finaliseFrom = (body) => {
  const b = body && typeof body === "object" ? body : {};
  const tier = text(b.tier || b.tierId, 40);
  const confirmed = b.confirm === true || b.holdConfirmed === true || Boolean(tier);
  if (!confirmed) {
    throw validation(
      { confirm: "Hold the ring, or type FINALISE, to confirm." },
      "Finalising is irreversible, so we need the confirmation from the ceremony."
    );
  }
  return { tier, shownTotal: money(b.total) };
};

/* ── the wedding store ────────────────────────────────────────────────────── */

/** A Decor catalogue document → the store card (§ 3.3). */
const shapeStoreProduct = (product) => {
  const types = (product && product.productTypes) || [];
  const prices = types.map((type) => money(type && type.sellingPrice)).filter(Boolean);
  const occasions = (product && product.productVariation && product.productVariation.occassion) || [];
  return {
    id: String((product && product._id) || ""),
    cat: slug(product && product.category),
    name: (product && product.name) || "",
    // A STARTING price — the cheapest tier this product is sold at. The team
    // prices the real thing (§ 06.3), which is the whole point of the draft.
    from: prices.length ? Math.min.apply(null, prices) : 0,
    note: text(product && product.description, 240),
    photo: (product && (product.thumbnail || product.image)) || null,
    suits: occasions.map((occasion) => eventKeyOf(occasion)).filter(Boolean),
  };
};

/** `POST /wedding/:id/store/draft/items { productId }`. */
const storeItemFrom = (body) => {
  const productId = text(body && (body.productId || body.id), 40);
  if (!productId) throw validation({ productId: "Tell us which piece." }, "Nothing to add.");
  return productId;
};

/**
 * A draft → the QuoteRequest payload (§ 06.3, "Store draft → Décor drafts").
 *
 * Deliberately the couple's picks VERBATIM plus the ids that let the Store/CS
 * team open the wedding: `QuoteRequest.payload` is documented on the model as
 * "the couple's picks, verbatim", and it is worked from the existing quote
 * queue. Nothing here prices anything, and nothing here invents a second
 * status vocabulary — the request comes back priced through the SAME queue the
 * concierge path uses.
 */
const quoteRequestPayload = ({ weddingId, draft, event, now = new Date() }) => {
  const items = (draft && draft.items) || [];
  return {
    source: "couple-app-store",
    weddingId: String(weddingId || ""),
    leadId: event && event.leadId ? String(event.leadId) : null,
    draftName: text(draft && draft.name, 200),
    sentAt: now,
    items: items.map((item) => ({
      productId: String((item && item.productId) || ""),
      name: (item && item.name) || "",
      category: (item && item.cat) || "",
      startingPrice: money(item && item.from),
    })),
    // What the team needs to price it against, read off the Event and never
    // re-typed: the functions, their dates and their venues (§ 06.3 "Events").
    events: ((event && event.eventDays) || []).map((day) => ({
      id: String((day && day._id) || ""),
      name: (day && day.name) || "",
      date: (day && day.date) || "",
      venue: (day && day.venue) || "",
    })),
  };
};

/** The draft, as `GET /wedding/:id/store/draft` returns it (§ 06.1 StoreDraft). */
const shapeStoreDraft = (draft, weddingId) => {
  const d = draft || {};
  return {
    id: String(d.quoteRequest || weddingId || ""),
    name: d.name || "",
    status: d.status || "building",
    sentAt: d.sentAt || null,
    quoteRequestId: d.quoteRequest ? String(d.quoteRequest) : null,
    items: ((d.items) || []).map((item) => ({
      id: String((item && item.productId) || ""),
      itemId: String((item && item._id) || ""),
      productId: String((item && item.productId) || ""),
      name: (item && item.name) || "",
      cat: (item && item.cat) || "",
      from: money(item && item.from),
    })),
  };
};

/* ── makeup ───────────────────────────────────────────────────────────────── */

/**
 * `PUT /wedding/:id/makeup/brief`.
 *
 * The client's form: date, functions[], budgetLow, budgetHigh, people, looks.
 * `date` is left as the couple typed it (the Event stores its dates as strings
 * too), the functions are narrowed to keys this wedding has, and the budget is
 * ordered — a low above a high is a slider dragged past itself, not an error
 * worth stopping them for.
 */
const briefFrom = (body, allowedKeys) => {
  const b = body && typeof body === "object" ? body : {};
  const known = Array.isArray(allowedKeys) && allowedKeys.length ? allowedKeys : EVENT_KEY;
  const functions = (Array.isArray(b.functions) ? b.functions : [])
    .map((key) => eventKeyOf(key))
    .filter((key) => key && known.indexOf(key) !== -1);

  const low = money(b.budgetLow);
  const high = money(b.budgetHigh);
  const people = Math.min(20, Math.max(1, Math.floor(Number(b.people) || 1)));

  if (!low && !high) {
    throw validation(
      { budgetLow: "Tell the artists what you can spend." },
      "An artist cannot bid against a blank budget."
    );
  }

  return {
    date: text(b.date, 40),
    functions,
    budgetLow: Math.min(low || high, high || low),
    budgetHigh: Math.max(low || high, high || low),
    people,
    looks: text(b.looks, 2000),
  };
};

/** A BiddingBid + its Vendor → the comparable bid card (§ 3.5). */
const shapeBid = (bid, vendor, reviewCount) => {
  const status = (bid && bid.status) || {};
  const address = (vendor && vendor.businessAddress) || {};
  return {
    id: String((bid && bid._id) || ""),
    artistId: String((vendor && vendor._id) || (bid && bid.vendor) || ""),
    name: (vendor && (vendor.businessName || vendor.name)) || "",
    avatar: (vendor && vendor.gallery && vendor.gallery.coverPhoto) || null,
    rating: Number((vendor && vendor.rating) || 0),
    reviews: Number(reviewCount || 0),
    city: address.city || "",
    amount: money(bid && bid.bid),
    // The artist's own words. Every other "comparable fact" the finished card
    // renders — covers, travel, trial, products — has no field on BiddingBid,
    // so it comes back empty rather than assembled out of this note.
    note: (bid && bid.vendor_notes) || "",
    covers: "",
    travel: "",
    trial: "",
    products: ((vendor && vendor.other && vendor.other.makeupProducts) || []).join(", "),
    bidAt: (bid && bid.createdAt) || null,
    accepted: Boolean(status.userAccepted),
    rejected: Boolean(status.userRejected),
  };
};

/**
 * ACCEPTING A BID — which row wins, which rows lose, and whether this has
 * already happened. PURE, so the whole decision is testable with literals and
 * the service is left with nothing but the writes.
 *
 * `alreadyAccepted` is a VALUE, not an error, for the same reason
 * CoupleDecorFinaliseService returns `alreadyFinalised` as one: a couple who
 * tapped twice has accepted, and the second answer should equal the first.
 * Accepting a DIFFERENT bid once one is accepted IS refused — that is not a
 * double tap, it is changing an agreement with an artist who has been told.
 */
const acceptance = (bids, bidId) => {
  const rows = Array.isArray(bids) ? bids : [];
  const target = String(bidId || "");
  const winner = rows.find((bid) => bid && String(bid._id) === target) || null;
  if (!winner) return { ok: false, reason: "not_found", winner: null, losers: [], alreadyAccepted: false };

  const acceptedElsewhere = rows.find(
    (bid) => bid && bid.status && bid.status.userAccepted && String(bid._id) !== target
  );
  if (acceptedElsewhere) {
    return {
      ok: false,
      reason: "already_accepted",
      winner,
      losers: [],
      alreadyAccepted: false,
      acceptedId: String(acceptedElsewhere._id),
    };
  }

  const alreadyAccepted = Boolean(winner.status && winner.status.userAccepted);
  // EVERY other bid loses — including one already marked, so a retry converges
  // rather than leaving a row that was missed the first time.
  const losers = rows
    .filter((bid) => bid && String(bid._id) !== target)
    .map((bid) => String(bid._id));

  return { ok: true, reason: "", winner, losers, alreadyAccepted };
};

module.exports = {
  fail,
  validation,
  notFound,
  money,
  text,
  slug,
  eventKeyOf,
  REACTIONS,
  reactionToStored,
  reactionFromStored,
  reactionFrom,
  shapeShortlistVenue,
  shapeVenueMessage,
  shapeOffer,
  heartFrom,
  tierFrom,
  finaliseFrom,
  shapeStoreProduct,
  storeItemFrom,
  quoteRequestPayload,
  shapeStoreDraft,
  briefFrom,
  shapeBid,
  acceptance,
};
