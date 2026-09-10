/* THE WEDDING STORE (§ 3.3, § 06.2) — the couple's own pick-list, and the one
 * pipeline it goes into.
 *
 * ── § 06.3 "STORE DRAFT → DÉCOR DRAFTS", WHICH IS THE WHOLE POINT ──────────
 *
 *     "A sent store draft becomes a quote request and returns as a priced
 *      draft in the same Décor flow as concierge picks. Both paths converge on
 *      one Finalise."
 *
 * models/QuoteRequest IS that pipeline — "the couple sent their picks for
 * pricing ('send for quote' in the app); worked by the Store/CS teams from the
 * workspace queue" — and services/QuoteRequestService.ingest is its one door:
 * it resolves the lead, queues the row, echoes the activity spine, raises the
 * needs-attention notification to the lead owner and drops the décor-lane
 * entry. `send` below CALLS that. It does not create a QuoteRequest by hand,
 * it does not price anything, and it opens nothing the concierge path does not
 * already use. What comes back comes back through `GET /wedding/:id/decor`,
 * priced, beside the looks Meera presented.
 *
 * ── THE CATALOGUE IS THE REAL ONE ──────────────────────────────────────────
 * `GET …/store/catalogue` is served from models/Decor and models/Category —
 * the products the Wedsy store actually sells, at the starting price their own
 * cheapest productType carries. There is no second product list on this
 * server, and a hardcoded one here would go stale the first time a price moved.
 */

const Event = require("../models/Event");
const Decor = require("../models/Decor");
const Category = require("../models/Category");

const QuoteRequestService = require("./QuoteRequestService");
const activityService = require("./CoupleActivityService");
const peopleRules = require("./CouplePeopleRules");
const rules = require("./CouplePlanningRules");
const { isId } = require("../utils/objectId");

const CATALOGUE_LIMIT = 300;

/** The couple's draft as it is stored, never null. */
const draftOf = (event) => (event && event.coupleApp && event.coupleApp.storeDraft) || {};

const note = (couple, { action, objectId, summary }) => {
  const actor = peopleRules.actorOf(couple);
  return activityService.record({
    weddingId: couple.weddingId,
    actorType: actor.type,
    actor: { id: actor.id, name: actor.name },
    action,
    objectType: "storeDraft",
    objectId,
    summary,
  });
};

/**
 * GET /wedding/:id/store/catalogue — gated `decor / view`.
 *
 * Only what is actually for sale: visible AND available. A product the store
 * has hidden is not something to let a couple build a plan around.
 */
const catalogue = async () => {
  const [categories, products] = await Promise.all([
    Category.find({ status: true }, { name: 1, order: 1 }).sort({ order: 1, name: 1 }).lean(),
    Decor.find(
      { productVisibility: true, productAvailability: true },
      {
        name: 1,
        category: 1,
        description: 1,
        thumbnail: 1,
        image: 1,
        productTypes: 1,
        "productVariation.occassion": 1,
        bestSellerOrder: 1,
      }
    )
      .sort({ bestSellerOrder: 1, name: 1 })
      .limit(CATALOGUE_LIMIT)
      .lean(),
  ]);

  const shaped = products.map(rules.shapeStoreProduct);
  // Only the categories that have something in them, plus "Everything" — a tab
  // that filters to an empty shelf is a tab the couple taps once.
  const stocked = new Set(shaped.map((product) => product.cat));

  return {
    categories: [{ id: "all", label: "Everything" }].concat(
      categories
        .filter((category) => stocked.has(rules.slug(category.name)))
        .map((category) => ({ id: rules.slug(category.name), label: category.name }))
    ),
    products: shaped,
  };
};

/** GET /wedding/:id/store/draft — gated `decor / view`. */
const draft = async (couple) => rules.shapeStoreDraft(draftOf(couple.event), couple.weddingId);

/**
 * POST /wedding/:id/store/draft/items { productId } — gated `decor / edit`.
 *
 * The product is looked up rather than trusted: the name, category and
 * starting price stored on the draft are the CATALOGUE's, so a body carrying
 * `from: 1` puts nothing in front of the team that prices it.
 *
 * Adding to a draft that has already gone to the team puts it back in
 * "building" — the sent one is theirs to price now, and the next send raises
 * a new request rather than editing the one on their queue.
 */
const addItem = async (couple, body) => {
  const productId = rules.storeItemFrom(body);
  if (!isId(productId)) throw rules.notFound("We could not find that piece in the store.");

  const product = await Decor.findOne(
    { _id: productId, productVisibility: true, productAvailability: true },
    { name: 1, category: 1, productTypes: 1 }
  ).lean();
  if (!product) throw rules.notFound("We could not find that piece in the store.");

  const current = draftOf(couple.event);
  const items = current.items || [];
  if (items.some((item) => String(item.productId) === String(productId))) {
    return { ok: true, alreadyInDraft: true, draft: rules.shapeStoreDraft(current, couple.weddingId) };
  }
  if (items.length >= 60) {
    throw rules.fail(409, "draft_full", "That is a very full draft — send it for a quote before adding more.");
  }

  const shaped = rules.shapeStoreProduct(product);
  await Event.updateOne(
    { _id: couple.weddingId },
    {
      $push: {
        "coupleApp.storeDraft.items": {
          productId: String(productId),
          name: shaped.name,
          cat: shaped.cat,
          from: shaped.from,
          addedAt: new Date(),
        },
      },
      $set: { "coupleApp.storeDraft.status": "building" },
    }
  );

  const updated = await Event.findById(couple.weddingId, { "coupleApp.storeDraft": 1 }).lean();
  return { ok: true, alreadyInDraft: false, draft: rules.shapeStoreDraft(draftOf(updated), couple.weddingId) };
};

/**
 * DELETE /wedding/:id/store/draft/items/:itemId — gated `decor / edit`.
 *
 * `:itemId` is the PRODUCT id, because that is what the client removes with
 * (`api.removeStoreItem(weddingId, product.id)`); the draft row's own subdocument
 * id is accepted too, so the § 06.2 reading of the path works as well.
 */
const removeItem = async (couple, itemId) => {
  const id = rules.text(itemId, 40);
  const current = draftOf(couple.event);
  const items = current.items || [];
  const row = items.find(
    (item) => String(item.productId) === id || String(item._id) === id
  );
  if (!row) throw rules.notFound("That is not in your draft.");

  await Event.updateOne(
    { _id: couple.weddingId },
    {
      $pull: { "coupleApp.storeDraft.items": { productId: String(row.productId) } },
      $set: { "coupleApp.storeDraft.status": "building" },
    }
  );

  const updated = await Event.findById(couple.weddingId, { "coupleApp.storeDraft": 1 }).lean();
  return { ok: true, removed: String(row.productId), draft: rules.shapeStoreDraft(draftOf(updated), couple.weddingId) };
};

/**
 * POST /wedding/:id/store/draft/send — gated `decor / edit`.
 *
 * ⚠ § 06.3 — "Store draft → Décor drafts". THE CONVERGENCE RULE.
 *
 * The request created here is the SAME quote request the concierge path
 * creates: one row on models/QuoteRequest, raised through the one door
 * (services/QuoteRequestService.ingest), worked from the one queue
 * (/quote-requests, the Store/CS workspace), and returning as a priced draft in
 * the SAME décor flow the concierge picks return through. Both paths end at
 * ONE finalise — services/CoupleDecorFinaliseService, called from
 * services/CoupleDecorService.finalise.
 *
 * ANYTHING ON THIS SERVER THAT TREATS A STORE DRAFT AS ITS OWN KIND OF ORDER
 * BREAKS THAT PROMISE. There is deliberately no store-order model, no second
 * status vocabulary and no pricing in this file.
 *
 * The ITEMS SENT ARE THE SERVER'S, not the body's. The client posts its local
 * mirror of the draft; the couple's draft is what this server recorded as they
 * tapped, and pricing a list a browser assembled would price something nobody
 * can audit. Only the draft's NAME is taken from the request.
 */
const send = async (couple, body) => {
  const current = draftOf(couple.event);
  const items = current.items || [];
  if (!items.length) {
    throw rules.fail(422, "empty_draft", "There is nothing in your draft to send yet.");
  }

  const name = rules.text(body && body.name, 200) || current.name || "";
  const now = new Date();
  const payload = rules.quoteRequestPayload({
    weddingId: couple.weddingId,
    draft: { ...current, name },
    event: couple.event,
    now,
  });

  const request = await QuoteRequestService.ingest({
    leadId: couple.event.leadId || null,
    userId: couple.event.user || couple.userId,
    draftName: name,
    itemCount: items.length,
    payload,
    sentAt: now,
  });

  await Event.updateOne(
    { _id: couple.weddingId },
    {
      $set: {
        "coupleApp.storeDraft.name": name,
        "coupleApp.storeDraft.status": "sent",
        "coupleApp.storeDraft.sentAt": now,
        "coupleApp.storeDraft.quoteRequest": request._id,
      },
    }
  );

  await note(couple, {
    action: "store.draft_sent",
    objectId: request._id,
    summary: `Sent ${items.length} ${items.length === 1 ? "piece" : "pieces"} to the team for a quote`,
  });

  /* ⛏ NOTIFICATION TRIGGER — NOT ADDED (project hard rule: triggers only,
   * through services/NotificationService.js, WhatsApp via the Meta Cloud API,
   * never Aisensy, and only after reading the Notification System spec in
   * Notion). The moment: the couple sends their store draft for a quote. The
   * trigger this wants is `couple_store_draft_sent`, to the couple ("Ravi will
   * price it and reply") — the TEAM's half already exists and is not this
   * milestone's to add: QuoteRequestService.ingest raises the needs-attention
   * notification to the lead owner and the décor-lane entry today. */

  return {
    ok: true,
    status: "sent",
    sentAt: now,
    itemCount: items.length,
    quoteRequestId: String(request._id),
    draft: rules.shapeStoreDraft({ ...current, name, status: "sent", sentAt: now, quoteRequest: request._id }, couple.weddingId),
  };
};

module.exports = { catalogue, draft, addItem, removeItem, send, draftOf };
