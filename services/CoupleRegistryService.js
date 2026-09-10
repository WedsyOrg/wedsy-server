/* THE COUPLE'S SIDE OF THE REGISTRY (§ 05.1, § 06.2).
 *
 * Reads and writes for the Gifts, Funds and Thank-yous tabs. Everything that is
 * a rule rather than a query lives in services/CoupleRegistryRules — shaping,
 * validation, the refusal bodies — so this file is the part that talks to
 * MongoDB and nothing else.
 *
 * TWO THINGS THIS FILE DELIBERATELY DOES NOT DO:
 *
 *   • It never writes `funded` or `raised`. Those running totals move in the
 *     contribution's transaction (services/CoupleContributionService) and
 *     nowhere else — that single writer is what keeps them agreeing with the
 *     money that produced them. A PATCH that renames a gift cannot silently
 *     reset how much has been given towards it, because there is no branch here
 *     that could.
 *
 *   • It never deletes a gift money has arrived against. A guest's Contribution
 *     points at the row; `archivedAt` retires it from the wishlist and leaves
 *     the thank-you readable (CoupleRegistryRules.removalOf).
 */

const Website = require("../models/Website");
const RegistryItem = require("../models/RegistryItem");
const RegistryFund = require("../models/RegistryFund");
const Contribution = require("../models/Contribution");

const rules = require("./CoupleRegistryRules");
const activityService = require("./CoupleActivityService");
const { runAtomically, withSession } = require("../utils/coupleTransaction");

const fail = (refusal) => {
  const error = new Error((refusal.body && refusal.body.message) || "That could not be saved.");
  error.status = refusal.status;
  error.code = (refusal.body && refusal.body.error) || "error";
  error.extra = { ...refusal.body };
  delete error.extra.error;
  delete error.extra.message;
  return error;
};

/** Who did it, for the feed. A partner or a shared member — never an Admin ref. */
const actorOf = (couple) => ({
  actorType: "couple",
  actor: {
    id: couple && couple.userId,
    name: (couple && couple.user && (couple.user.name || couple.user.firstName)) || "Someone",
  },
});

const log = (couple, action, summary, objectType, objectId) =>
  activityService.record({
    weddingId: couple.weddingId,
    ...actorOf(couple),
    action,
    objectType,
    objectId,
    summary,
  });

/* ── read ─────────────────────────────────────────────────────────────────── */

/** GET /wedding/:id/registry — items, funds, their contributions and the note. */
const get = async (couple) => {
  const weddingId = couple.weddingId;
  const [website, items, funds, contributions] = await Promise.all([
    Website.findOne({ weddingId }, { slug: 1, registry: 1, paletteId: 1, fontId: 1 }).lean(),
    RegistryItem.find({ weddingId, archivedAt: null }).sort({ pinned: -1, sortOrder: 1, createdAt: -1 }).lean(),
    RegistryFund.find({ weddingId, archivedAt: null }).sort({ sortOrder: 1, createdAt: -1 }).lean(),
    Contribution.find({ weddingId, status: "settled" }).sort({ createdAt: -1 }).lean(),
  ]);
  return rules.couplePayload({ website, items, funds, contributions });
};

/* ── the note above the gifts ─────────────────────────────────────────────── */

/**
 * PATCH /wedding/:id/registry { intro } — ⛏ CONTRACT ADDITION.
 *
 * It writes `Website.registry.intro`, and UPSERTS the Website document if this
 * couple has not opened the builder yet: § 05.1 says the registry "works on its
 * own — no website needed", so writing the note must not require one to exist.
 * The insert sets `weddingId` only; the slug stays unset, which the sparse
 * unique index on Website.slug allows.
 */
const saveNote = async (couple, body) => {
  const decision = rules.introPatch(body);
  if (!decision.ok) throw fail(decision);

  const website = await Website.findOneAndUpdate(
    { weddingId: couple.weddingId },
    { $set: decision.set, $setOnInsert: { weddingId: couple.weddingId } },
    { upsert: true, new: true, projection: { registry: 1, slug: 1 } }
  ).lean();

  await log(couple, "registry.note", "Updated the note above your gift registry", "registry", couple.weddingId);
  const registry = (website && website.registry) || {};
  return { intro: registry.intro || "", layout: registry.layout === "list" ? "list" : "grid" };
};

/* ── gifts ────────────────────────────────────────────────────────────────── */

/** POST /wedding/:id/registry/items. */
const addItem = async (couple, body) => {
  const decision = rules.itemFields(body);
  if (!decision.ok) throw fail(decision);

  const created = await RegistryItem.create({
    ...decision.doc,
    weddingId: couple.weddingId,
    createdBy: couple.userId,
  });
  // Pinning is exclusive — § 05.1's "the one we're dreaming of most" is one.
  if (decision.doc.pinned) await unpinOthers(couple.weddingId, created._id, null);

  await log(couple, "registry.item_added", `Added ${decision.doc.title} to your gift registry`, "registryItem", created._id);
  return rules.shapeItem(created.toObject(), []);
};

/** One pinned gift per wedding. Cheap, idempotent, and safe to repeat. */
const unpinOthers = (weddingId, keepId, session) =>
  RegistryItem.updateMany(
    { weddingId, _id: { $ne: keepId }, pinned: true },
    { $set: { pinned: false } },
    withSession(session)
  );

/** POST /wedding/:id/registry/funds. */
const addFund = async (couple, body) => {
  const decision = rules.fundFields(body);
  if (!decision.ok) throw fail(decision);

  const created = await RegistryFund.create({
    ...decision.doc,
    weddingId: couple.weddingId,
    createdBy: couple.userId,
  });
  await log(couple, "registry.fund_added", `Started a fund: ${decision.doc.title}`, "registryFund", created._id);
  return rules.shapeFund(created.toObject(), []);
};

/**
 * PATCH /registry-items/:id and PATCH /registry-funds/:id.
 *
 * `req.coupleTarget` was loaded by the route's FromDocument, which is also what
 * resolved this row's weddingId and ran the ordinary membership test on it — so
 * by the time this runs, the row is known to belong to this caller's wedding.
 * The query below still scopes on `weddingId` as well: a filter that repeats
 * the check costs nothing and cannot be forgotten in a later refactor.
 */
const patchItem = async (couple, itemId, body) => {
  const decision = rules.patchGift(body, "item");
  if (!decision.ok) throw fail(decision);

  const run = async (session) => {
    if (decision.set.pinned === true) await unpinOthers(couple.weddingId, itemId, session);
    return RegistryItem.findOneAndUpdate(
      { _id: itemId, weddingId: couple.weddingId },
      { $set: decision.set },
      { new: true, ...withSession(session) }
    ).lean();
  };

  // Two writes when a pin moves, one otherwise. Atomic where the deployment
  // allows; a stray second pin is cosmetic, not money, so the fallback is fine.
  const { result } = await runAtomically(run);
  if (!result) throw fail(rules.notFound("We could not find that gift."));

  const contributions = await Contribution.find({ item: itemId, status: "settled" }).sort({ createdAt: -1 }).lean();
  return rules.shapeItem(result, contributions);
};

const patchFund = async (couple, fundId, body) => {
  const decision = rules.patchGift(body, "fund");
  if (!decision.ok) throw fail(decision);

  const updated = await RegistryFund.findOneAndUpdate(
    { _id: fundId, weddingId: couple.weddingId },
    { $set: decision.set },
    { new: true }
  ).lean();
  if (!updated) throw fail(rules.notFound("We could not find that fund."));

  const contributions = await Contribution.find({ fund: fundId, status: "settled" }).sort({ createdAt: -1 }).lean();
  return rules.shapeFund(updated, contributions);
};

/**
 * DELETE /registry-items/:id and /registry-funds/:id.
 *
 * Archive once money has arrived, remove otherwise (CoupleRegistryRules.removalOf).
 * The response says which happened, so the screen can word "removed" and
 * "retired" differently if it ever wants to.
 */
const removeGift = async (couple, kind, giftId) => {
  const Model = kind === "fund" ? RegistryFund : RegistryItem;
  const label = kind === "fund" ? "fund" : "gift";

  const gift = await Model.findOne({ _id: giftId, weddingId: couple.weddingId }).lean();
  if (!gift) throw fail(rules.notFound(`We could not find that ${label}.`));

  const how = rules.removalOf(gift);
  if (how === "archive") {
    await Model.updateOne({ _id: giftId, weddingId: couple.weddingId }, { $set: { archivedAt: new Date() } });
  } else {
    await Model.deleteOne({ _id: giftId, weddingId: couple.weddingId });
  }

  await log(
    couple,
    kind === "fund" ? "registry.fund_removed" : "registry.item_removed",
    `Removed ${gift.title || `a ${label}`} from your gift registry`,
    kind === "fund" ? "registryFund" : "registryItem",
    giftId
  );
  return { id: String(giftId), removed: how === "delete", archived: how === "archive" };
};

/* ── thank-yous ───────────────────────────────────────────────────────────── */

/**
 * PATCH /contributions/:id { thanked } — ⛏ CONTRACT ADDITION.
 *
 * § 06.1 hung `thanked` off RegistryItem. One gift carries contributions from
 * several people and the couple thanks people, so it lives on the Contribution.
 * Nothing here touches `amount`, `status` or `walletTxn`: a thank-you is a note
 * to self, not a movement of money.
 */
const thank = async (couple, contributionId, body) => {
  const decision = rules.thankedPatch(body);
  if (!decision.ok) throw fail(decision);

  const updated = await Contribution.findOneAndUpdate(
    { _id: contributionId, weddingId: couple.weddingId },
    { $set: decision.set },
    { new: true }
  ).lean();
  if (!updated) throw fail(rules.notFound("We could not find that gift."));

  if (decision.set.thanked) {
    await log(couple, "registry.thanked", `Thanked ${updated.guestName || "a guest"}`, "contribution", contributionId);
  }
  return rules.coupleContribution(updated);
};

module.exports = { get, saveNote, addItem, addFund, patchItem, patchFund, removeGift, thank, unpinOthers };
