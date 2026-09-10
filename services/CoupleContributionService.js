/* INVARIANT 2, AT THE ONE PLACE MONEY ENTERS — the public registry (§ 06.3).
 *
 *   "Every contribution credits the Wallet. The Wallet balance is offered as an
 *    offset in the Pay modal. Claiming debits it. Three screens, one ledger."
 *
 * A stranger with a WhatsApp link sends a gift. By the time this function
 * returns, three things are true or none of them are:
 *
 *   • the gift's running total has moved,
 *   • a Contribution exists, settled,
 *   • a WalletTxn credit exists for the same rupees, pointing at it.
 *
 * ── HOW THAT IS ACHIEVED, AND WHAT IT REALLY GUARANTEES ────────────────────
 * `utils/coupleTransaction.runAtomically` runs the whole thing inside ONE
 * MongoDB transaction wherever the deployment supports one — which production
 * does, because Wedsy runs on Atlas and every Atlas cluster is a replica set.
 * There, all three writes commit together or none of them do.
 *
 * On a deployment that cannot (a standalone mongod on a laptop), the fallback
 * ordering is chosen so the failure mode is reconcilable rather than wrong:
 * the reserve first (a single-document conditional update, atomic on ANY
 * MongoDB), then the Contribution as `pending` — which counts towards nothing:
 * not the balance, not the thank-you list — then the credit, and only then the
 * flip to `settled`. A crash in the middle leaves a pending row and a reserve
 * that is compensated on the way out. The invariant that survives either way is
 * **a settled Contribution always has its credit**.
 *
 * ── THE RACE, AND WHY IT IS A SINGLE-DOCUMENT UPDATE ───────────────────────
 * Two guests both tap "Pay in full" on the same lamp. The winner is decided by
 * a conditional `findOneAndUpdate` on the RegistryItem — `funded: { $lt: price }`
 * → `funded = price`, returning the PRE-IMAGE. The amount charged is derived
 * from that pre-image by CoupleWalletService.contributionAmount, so it is the
 * remainder the database actually saw, not the remainder the browser was
 * showing a second ago. The loser's update matches nothing and becomes the
 * `409 already_funded` the client renders. That guard does not depend on
 * transactions at all.
 */

const Website = require("../models/Website");
const Event = require("../models/Event");
const RegistryItem = require("../models/RegistryItem");
const RegistryFund = require("../models/RegistryFund");
const Contribution = require("../models/Contribution");
const WalletTxn = require("../models/WalletTxn");

const wallet = require("./CoupleWalletService");
const rules = require("./CoupleRegistryRules");
const websiteRules = require("./CoupleWebsiteRules");
const publicSite = require("./CouplePublicSiteService");
const activityService = require("./CoupleActivityService");
const { normalisePhone } = require("../utils/phone");
const { runAtomically, withSession } = require("../utils/coupleTransaction");

const fail = (status, code, message, extra) => {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  if (extra) error.extra = extra;
  return error;
};

const refuse = (refusal) => {
  const body = refusal.body || {};
  const extra = { ...body };
  delete extra.error;
  delete extra.message;
  return fail(refusal.status, body.error || "error", body.message || "That could not be saved.", extra);
};

/* ── resolving a registry link ────────────────────────────────────────────── */

/**
 * A slug → the website that owns it, its wedding, and whether this request has
 * proved the couple's password.
 *
 * `publishedAt` is NOT consulted: § 05.1 is explicit that the registry "works
 * on its own — no website needed", so a registry link resolves on a Website
 * document that has never been published. Only the SITE route requires it.
 *
 * The gate is the same gate: `CoupleWebsiteRules.isGated` /
 * `verifyUnlockToken`, and the secret comes from
 * `CouplePublicSiteService.unlockSecret` so there is one answer on this server
 * to "what signs an unlock", not two.
 */
const resolve = async (rawSlug, req) => {
  const slug = websiteRules.normaliseSlug(rawSlug);
  if (!slug) return null;
  const website = await Website.findOne({ slug }).select("+privacy.password").lean();
  if (!website) return null;
  const event = await Event.findById(website.weddingId).lean();
  if (!event) return null;

  const gated = websiteRules.isGated(website);
  const unlocked = gated
    ? websiteRules.verifyUnlockToken(slug, websiteRules.unlockTokenFrom(req, slug), publicSite.unlockSecret())
    : true;

  return { slug, website, event, gated, unlocked };
};

/**
 * GET /registry/:slug — PUBLIC.
 *
 * The gift rows are only READ when they are going to be sent: a locked registry
 * does not query the couple's wishlist at all. The withholding is a query that
 * does not happen, exactly as the site route does it.
 */
const publicRegistry = async (rawSlug, req) => {
  const found = await resolve(rawSlug, req);
  if (!found) throw fail(404, "not_found", "We could not find that gift registry.");

  const { website, event, gated, unlocked } = found;
  const locked = gated && !unlocked;

  const [items, funds] = locked
    ? [[], []]
    : await Promise.all([
        RegistryItem.find(
          { weddingId: website.weddingId, archivedAt: null },
          { title: 1, image: 1, price: 1, funded: 1, pinned: 1, sortOrder: 1 }
        )
          .sort({ pinned: -1, sortOrder: 1, createdAt: -1 })
          .limit(120)
          .lean(),
        RegistryFund.find(
          { weddingId: website.weddingId, archivedAt: null },
          { title: 1, image: 1, target: 1, raised: 1, sortOrder: 1 }
        )
          .sort({ sortOrder: 1, createdAt: -1 })
          .limit(40)
          .lean(),
      ]);

  return {
    payload: rules.publicRegistryPayload({
      website,
      event,
      items,
      funds,
      intro: (website.registry && website.registry.intro) || "",
      gated,
      unlocked,
      privacyOf: websiteRules.publicPrivacy,
      partnersOf: websiteRules.publicPartners,
    }),
    gated,
    unlocked,
    linkOnly: Boolean(website.privacy && website.privacy.linkOnly),
  };
};

/* ── the reserve: the race guard, one document, no transaction needed ─────── */

/**
 * Take the money on the GIFT first, atomically, and learn what the gift looked
 * like at the instant it was taken.
 *
 * @returns {{amount:number, before:object}} or throws the 409/422 the client renders
 */
const reserveOnItem = async (weddingId, itemId, mode, asked, session) => {
  const reread = async () => RegistryItem.findOne({ _id: itemId, weddingId, archivedAt: null }, null, withSession(session)).lean();

  const current = await reread();
  if (!current) throw refuse(rules.notFound("We could not find that gift."));

  if (mode === "full") {
    // Refuse the hopeless case before touching anything, from the row as read.
    const pre = rules.fullReserve(current);
    if (!pre.ok) throw refuse(pre.refusal);

    // ONE conditional update decides the race. `new: false` returns the
    // PRE-IMAGE — the only honest source for "what was left" — and the filter
    // pins both the price and "not yet fully funded", so the second of two
    // simultaneous guests matches nothing.
    const before = await RegistryItem.findOneAndUpdate(
      { _id: itemId, weddingId, archivedAt: null, price: pre.price, funded: { $lt: pre.price } },
      { $set: { funded: pre.price } },
      { new: false, ...withSession(session) }
    ).lean();
    if (!before) throw refuse(rules.alreadyFunded((await reread()) || current));

    // The amount charged is re-derived from the document the update actually
    // matched, by the ledger's own arithmetic. Never from the request body.
    const won = rules.fullReserve(before);
    if (!won.ok) throw refuse(won.refusal);
    return { amount: won.amount, before };
  }

  const pre = rules.partReserve(current, asked);
  if (!pre.ok) throw refuse(pre.refusal);

  // A priced gift may not be over-funded; a gift with no price yet is an
  // open-ended ask and has no ceiling to break.
  const filter = { _id: itemId, weddingId, archivedAt: null };
  if (pre.capped) filter.$expr = { $lte: [{ $add: ["$funded", pre.amount] }, "$price"] };

  const before = await RegistryItem.findOneAndUpdate(
    filter,
    { $inc: { funded: pre.amount } },
    { new: false, ...withSession(session) }
  ).lean();
  if (!before) {
    const fresh = await reread();
    if (!fresh) throw refuse(rules.notFound("We could not find that gift."));
    // Somebody moved the total while this guest was typing. The same pure
    // function says which of the two answers they get.
    const retry = rules.partReserve(fresh, asked);
    throw refuse(retry.ok ? rules.alreadyFunded(fresh) : retry.refusal);
  }
  return { amount: pre.amount, before };
};

/**
 * A fund has no ceiling. § 06.1: "an item can be bought out, a fund cannot be
 * over-subscribed into an error — money past the target is still welcome."
 */
const reserveOnFund = async (weddingId, fundId, asked, session) => {
  const amount = wallet.money(asked);
  if (amount <= 0) throw refuse(rules.validation({ amount: "How much would you like to give?" }));
  const before = await RegistryFund.findOneAndUpdate(
    { _id: fundId, weddingId, archivedAt: null },
    { $inc: { raised: amount } },
    { new: false, ...withSession(session) }
  ).lean();
  if (!before) throw refuse(rules.notFound("We could not find that fund."));
  return { amount, before };
};

/** Give back what a failed write reserved. Only ever reached on the no-transaction path. */
const unreserve = async (giftType, giftId, amount) => {
  const Model = giftType === "fund" ? RegistryFund : RegistryItem;
  const field = giftType === "fund" ? "raised" : "funded";
  try {
    await Model.updateOne({ _id: giftId }, { $inc: { [field]: -amount } });
  } catch (_) {
    /* Nothing better is available here. The pending Contribution left behind is
       what reconciliation reads; see docs/couple-app-api.md § Money. */
  }
};

/* ── the contribution ─────────────────────────────────────────────────────── */

/**
 * POST /registry/:slug/contribute — PUBLIC, rate-limited (§ 06.4).
 *
 * 200 { ok, contributionId, contribution, amount, walletCredited, gift }
 * 409 { error: "already_funded", funded, price }
 * 422 { error: "validation", fields }
 * 404 an unknown slug, or a gift that is not on this wedding
 */
const contribute = async (rawSlug, body, req) => {
  const found = await resolve(rawSlug, req);
  if (!found) throw fail(404, "not_found", "We could not find that gift registry.");
  // A locked registry accepts no money either: a stranger who cannot see the
  // gifts must not be able to move rupees against one by guessing its id.
  if (found.gated && !found.unlocked) throw fail(404, "not_found", "We could not find that gift registry.");

  const decision = rules.contributionFields(body);
  if (!decision.ok) throw refuse(decision);

  const weddingId = found.website.weddingId;
  const giftType = decision.gift.giftType;
  const giftId = giftType === "fund" ? decision.gift.fundId : decision.gift.itemId;

  const guest = {
    ...decision.guest,
    // Both sides through this repo's ONE phone rule (§ 06.3 #4), so a guest who
    // also sits on the couple's guest list can be recognised later without a
    // second phone implementation being invented for money.
    phoneNormalised: decision.guest.phone ? normalisePhone(decision.guest.phone) : "",
  };

  /**
   * Everything that must land together. Re-entrant on purpose: MongoDB re-runs
   * this whole function on a write conflict, and every read inside it is
   * re-read, so a retry re-derives the amount instead of reusing a stale one.
   */
  const work = async (session) => {
    const reserved =
      giftType === "fund"
        ? await reserveOnFund(weddingId, giftId, decision.asked, session)
        : await reserveOnItem(weddingId, giftId, decision.mode, decision.asked, session);

    const writes = wallet.contributionWrites({
      weddingId,
      gift: reserved.before,
      giftType,
      mode: decision.mode,
      amount: reserved.amount,
      guest,
    });

    if (session) {
      // ── THE ATOMIC PATH ──────────────────────────────────────────────────
      // Both documents, one commit. The credit is written first only so the
      // Contribution can carry its id; either both exist after this block or
      // neither does.
      const [credit] = await WalletTxn.create([writes.walletTxn], { session });
      const [contribution] = await Contribution.create(
        [{ ...writes.contribution, guestPhoneNormalised: guest.phoneNormalised, walletTxn: credit._id }],
        { session }
      );
      await WalletTxn.updateOne({ _id: credit._id }, { $set: { contribution: contribution._id } }, { session });
      return { contribution, credit, amount: reserved.amount, gift: reserved.before };
    }

    // ── THE ORDERED PATH ─────────────────────────────────────────────────
    // No transaction available. The Contribution is written PENDING, which no
    // balance, no total and no thank-you list counts; it becomes settled only
    // once its credit exists. See the header for what this does and does not
    // guarantee.
    let contribution = null;
    try {
      contribution = await Contribution.create({
        ...writes.contribution,
        guestPhoneNormalised: guest.phoneNormalised,
        status: "pending",
        settledAt: null,
        walletTxn: null,
      });
      const credit = await WalletTxn.create(writes.walletTxn);
      const settled = await Contribution.findOneAndUpdate(
        { _id: contribution._id, status: "pending" },
        { $set: { status: "settled", settledAt: new Date(), walletTxn: credit._id } },
        { new: true }
      );
      await WalletTxn.updateOne({ _id: credit._id }, { $set: { contribution: contribution._id } });
      return { contribution: settled || contribution, credit, amount: reserved.amount, gift: reserved.before };
    } catch (error) {
      await unreserve(giftType, giftId, reserved.amount);
      if (contribution) {
        try {
          await Contribution.updateOne({ _id: contribution._id, status: "pending" }, { $set: { status: "failed" } });
        } catch (_) {
          /* left pending for reconciliation, which is what pending is for */
        }
      }
      throw error;
    }
  };

  const { result, atomic } = await runAtomically(work);

  // ── ACTIVITY: outside the money, on purpose ───────────────────────────────
  // ActivityLogService swallows its own failures, so a feed row that cannot be
  // written can never fail a gift that was. § 06.3 asks for one on every guest
  // action and this is the one branch that reaches it.
  await activityService.record({
    weddingId,
    actorType: "guest",
    actor: { name: guest.name },
    action: "registry.gift_received",
    objectType: giftType === "fund" ? "registryFund" : "registryItem",
    objectId: giftId,
    summary: `${guest.name} sent ₹${result.amount.toLocaleString("en-IN")} towards ${result.gift.title || "your registry"}`,
    meta: { source: "registry", slug: found.slug, amount: result.amount },
  });

  // ── NOTIFICATION TRIGGER, NOT ADDED HERE ─────────────────────────────────
  // A gift arriving is exactly the moment the couple wants to hear from us:
  // `couple_registry_gift`, named in docs/couple-app-api.md § 6. TRIGGERS ONLY,
  // through services/NotificationService.js, WhatsApp via the Meta Cloud API —
  // never Aisensy — and only after the Notification System spec in Notion.
  // Nothing is sent by this milestone.

  return {
    ok: true,
    contributionId: String(result.contribution._id),
    amount: result.amount,
    // The server confirming § 06.3 happened: the money is in the wallet before
    // this response returns, with nothing for the couple to do.
    walletCredited: result.amount,
    atomic,
    // Echoed back to the guest who just typed it, and to nobody else — this is
    // the only place a name and a note leave the server on a public route, and
    // they are the sender's own.
    contribution: {
      id: String(result.contribution._id),
      guestName: guest.name,
      amount: result.amount,
      note: guest.note,
      createdAt: result.contribution.createdAt || new Date(),
    },
    gift: {
      id: String(giftId),
      kind: giftType,
      title: result.gift.title || "",
      funded: wallet.money(giftType === "fund" ? result.gift.raised : result.gift.funded) + result.amount,
      price: wallet.money(giftType === "fund" ? result.gift.target : result.gift.price),
    },
  };
};

module.exports = { resolve, publicRegistry, contribute, reserveOnItem, reserveOnFund };
