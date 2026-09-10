/* THE OTHER TWO VIEWS OF THE ONE LEDGER — the Wallet strip (§ 05.1) and
 * Payments (§ 05.4).
 *
 * The registry is where money arrives; this file is where it sits and where it
 * leaves. Four endpoints, and three rules that decide all of them:
 *
 *   1. NO STORED BALANCE. Every figure here is summed from models/WalletTxn on
 *      the way out, by services/CoupleWalletService. There is no field to
 *      update, so there is no field to be wrong.
 *
 *   2. THE OFFSET IS THE SERVER'S. `POST /payments/:id/pay` reads exactly two
 *      things from the request — `method` and `useWallet: boolean` — because
 *      CoupleRegistryRules.payBody emits exactly those two keys and
 *      CoupleWalletService.applyWallet has no parameter an amount could arrive
 *      in. A client that posts `walletApplied: 999999` posts a field that
 *      reaches no variable.
 *
 *   3. A PAYOUT IS NOT A PERMISSION ANYONE CAN BE GRANTED. Neither function
 *      that moves money out checks a section: the routes mount `RequirePayout`
 *      instead, and `canInitiatePayout` reads no access map at all. There is no
 *      value in a SharedMember document that could reach these two functions.
 *
 * ── WHAT THIS MILESTONE DOES NOT DO ────────────────────────────────────────
 * It does not call Razorpay. `pay()` returns a well-formed INTENT and says so
 * in the response (`intent.provider`, `intent.mode`, `intent.dormant`), reading
 * utils/payment's own `razorpayConfigured()` / `razorpayMode()` so the answer
 * is the truth about this deploy rather than a guess. Creating the order and
 * handling its webhook is the next piece of work, written up in
 * docs/couple-app-api.md § Money. A payment the WALLET COVERS IN FULL involves
 * no gateway at all and IS settled here — that path is real money moving, and
 * it moves atomically.
 */

const Payment = require("../models/Payment");
const WalletTxn = require("../models/WalletTxn");

const wallet = require("./CoupleWalletService");
const rules = require("./CoupleRegistryRules");
const activityService = require("./CoupleActivityService");
const { razorpayConfigured, razorpayMode } = require("../utils/payment");
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
  return fail(refusal.status, body.error || "error", body.message || "That could not be done.", extra);
};

/** Every ledger row for one wedding, newest first. The balance is summed from these. */
const ledgerOf = (weddingId, session) =>
  WalletTxn.find({ weddingId }, null, withSession(session)).sort({ createdAt: -1 }).lean();

const actorOf = (couple) => ({
  actorType: "couple",
  actor: {
    id: couple && couple.userId,
    name: (couple && couple.user && (couple.user.name || couple.user.firstName)) || "Someone",
  },
});

/* ── the wallet ───────────────────────────────────────────────────────────── */

/**
 * GET /wedding/:id/wallet.
 *
 * Gated on registry/view AND payments/view — the wallet strip sits on the
 * Registry screen and the gift-wallet tile sits on Payments, and this one
 * balance is both. See docs/couple-app-api.md § Money for the consequence.
 */
const getWallet = async (couple) => rules.walletPayload(await ledgerOf(couple.weddingId));

/**
 * POST /wedding/:id/wallet/claim — money to the couple's bank. `RequirePayout`.
 *
 * The decision — is there anything to claim, is this more than there is — is
 * CoupleWalletService.claimWrite's, returned as VALUES so this function can
 * turn either into the 422 the screen renders rather than catching an
 * exception it would have to classify.
 *
 * What is handed to it is `spendable`, not `balance`: a claim already in flight
 * is money already promised to the bank, and the same rupees must not be
 * claimable twice while the first is pending. See CoupleRegistryRules.spendable
 * for why that figure is computed here rather than inside the ledger service.
 */
const claim = async (couple, body) => {
  const asked = body && body.amount !== undefined ? body.amount : undefined;

  const work = async (session) => {
    const txns = await ledgerOf(couple.weddingId, session);
    const decision = wallet.claimWrite({
      weddingId: couple.weddingId,
      amount: asked,
      walletBalance: rules.spendable(txns),
      initiatedBy: couple.userId,
    });
    if (!decision.ok) {
      const message =
        decision.error === "nothing_to_claim"
          ? "There is nothing in your wallet to claim yet."
          : "That is more than your wallet holds.";
      throw refuse(rules.validation({ amount: message }, message));
    }
    const created = session
      ? (await WalletTxn.create([decision.txn], { session }))[0]
      : await WalletTxn.create(decision.txn);
    const after = await ledgerOf(couple.weddingId, session);
    return { txn: created, wallet: rules.walletPayload(after) };
  };

  const { result } = await runAtomically(work);

  await activityService.record({
    weddingId: couple.weddingId,
    ...actorOf(couple),
    action: "wallet.claim_requested",
    objectType: "walletTxn",
    objectId: result.txn._id,
    summary: `Requested ₹${wallet.money(result.txn.amount).toLocaleString("en-IN")} from your gift wallet to your bank`,
  });

  // ── NOTIFICATION TRIGGER, NOT ADDED HERE ─────────────────────────────────
  // `couple_wallet_claim` — requested, and again when it settles or fails.
  // TRIGGERS ONLY, through services/NotificationService.js, WhatsApp via the
  // Meta Cloud API — never Aisensy — after the Notification System spec in
  // Notion. Nothing is sent by this milestone.

  return {
    ok: true,
    claim: rules.shapeTxn(result.txn),
    // § 05.1's promise, in the response so one screen cannot word it differently.
    message: "Claim requested — funds reach your bank in 2–3 working days.",
    wallet: result.wallet,
  };
};

/* ── payments ─────────────────────────────────────────────────────────────── */

/**
 * GET /wedding/:id/payments — a bare array, newest due first, exactly as
 * `api.payments()` reads it.
 *
 * Scoped on `coupleApp.weddingId` (the indexed, denormalised field) rather than
 * on `event`, so a payment row that belongs to the CRM's side of this Event and
 * was never meant for the couple's screen does not appear on it.
 */
const listPayments = async (couple) => {
  const rows = await Payment.find({ "coupleApp.weddingId": couple.weddingId })
    .sort({ "coupleApp.dueDate": 1, createdAt: 1 })
    .lean();
  return rows.map(rules.shapePayment);
};

/** Load one payment and be sure it is this wedding's. */
const loadPayment = async (weddingId, paymentId, session) => {
  const row = await Payment.findOne(
    { _id: paymentId, "coupleApp.weddingId": weddingId },
    null,
    withSession(session)
  ).lean();
  if (!row) throw refuse(rules.notFound("We could not find that payment."));
  return row;
};

/**
 * POST /payments/:id/pay { method, useWallet } — `RequirePayout`.
 *
 * ── THE OFFSET, AND WHY IT CANNOT BE CLIENT-SUPPLIED ──────────────────────
 * `rules.payBody(body)` is the only thing that reads the request, and it emits
 * `{ method, useWallet }`. The amount then comes from
 * `wallet.applyWallet(due, spendable, useWallet)` — three arguments, two of
 * which this server computed a line earlier and the third a strict boolean.
 * There is no path from a request body to `walletApplied`.
 *
 * ── TWO OUTCOMES ──────────────────────────────────────────────────────────
 * • The wallet covers the whole row. There is no gateway. The debit and the
 *   settled Payment are written TOGETHER, and the couple is paid up.
 * • It does not. A `pending` debit RESERVES the offset (so the same rupees
 *   cannot also be claimed to the bank while the card is being typed) and an
 *   intent comes back for the remainder. Settling that intent — flipping the
 *   debit to settled and the Payment to paid — belongs to the gateway callback
 *   this milestone does not build; an abandoned intent's reservation is
 *   released by reconciliation. Both are named in docs/couple-app-api.md § Money.
 */
const pay = async (couple, paymentId, body) => {
  const { method, useWallet } = rules.payBody(body);

  const work = async (session) => {
    const payment = await loadPayment(couple.weddingId, paymentId, session);
    if (rules.paymentState(payment) === "paid") {
      throw fail(409, "already_paid", "This one has already been settled.", {
        payment: rules.shapePayment(payment),
      });
    }
    const due = rules.outstanding(payment);
    if (due <= 0) {
      throw fail(409, "already_paid", "There is nothing left to pay on this one.", {
        payment: rules.shapePayment(payment),
      });
    }

    const txns = await ledgerOf(couple.weddingId, session);
    // THE OFFSET. Three arguments; none of them came from the browser.
    const applied = wallet.applyWallet(due, rules.spendable(txns), useWallet);

    let debit = null;
    if (applied.walletApplied > 0) {
      const row = wallet.debitWrite({
        weddingId: couple.weddingId,
        paymentId: payment._id,
        amount: applied.walletApplied,
        label: `Applied to ${(payment.coupleApp && payment.coupleApp.label) || "an instalment"}`,
        initiatedBy: couple.userId,
      });
      // Settled when the wallet is the whole payment; pending — a reservation —
      // while a gateway still has to answer for the rest.
      if (!applied.fullyCovered) {
        row.status = "pending";
        row.settledAt = null;
        row.ref = "Reserved for a payment in progress";
      }
      debit = session ? (await WalletTxn.create([row], { session }))[0] : await WalletTxn.create(row);
    }

    const set = { "coupleApp.walletApplied": applied.walletApplied };
    if (applied.fullyCovered) {
      // No gateway was involved, so this row is settled here and now.
      set.status = "paid";
      set.amountPaid = wallet.money(payment.amountPaid) + applied.walletApplied;
      set.amountDue = Math.max(0, due - applied.walletApplied);
    }
    await Payment.updateOne({ _id: payment._id }, { $set: set }, withSession(session));

    const after = await loadPayment(couple.weddingId, paymentId, session);
    return { payment: after, applied, debit, ledger: await ledgerOf(couple.weddingId, session) };
  };

  const { result, atomic } = await runAtomically(work);
  const { applied } = result;

  if (applied.fullyCovered) {
    await activityService.record({
      weddingId: couple.weddingId,
      ...actorOf(couple),
      action: "payment.paid",
      objectType: "payment",
      objectId: paymentId,
      summary: `Settled ${(result.payment.coupleApp && result.payment.coupleApp.label) || "an instalment"} with your gift wallet`,
    });
    // ── NOTIFICATION TRIGGER, NOT ADDED HERE ───────────────────────────────
    // A payment succeeding wants a receipt. Reuse the existing `event_pmnt_rmnd`
    // family rather than minting a new one — docs/couple-app-api.md § 6.
    // TRIGGERS ONLY, via services/NotificationService.js, WhatsApp on the Meta
    // Cloud API, never Aisensy.
  }

  return {
    ok: true,
    id: String(paymentId),
    amount: rules.outstanding(result.payment) + applied.walletApplied,
    walletApplied: applied.walletApplied,
    gatewayAmount: applied.gatewayAmount,
    fullyCovered: applied.fullyCovered,
    method,
    atomic,
    payment: rules.shapePayment(result.payment),
    wallet: rules.walletPayload(result.ledger),
    /**
     * The gateway intent. Well-formed and honest: `dormant` says whether this
     * deploy has Razorpay keys at all, `mode` says live or test, and `orderId`
     * is null because no order has been created yet. The keys themselves are
     * read from the environment inside utils/payment and are never named here.
     */
    intent: applied.fullyCovered
      ? null
      : {
          provider: "razorpay",
          mode: razorpayMode(),
          dormant: !razorpayConfigured(),
          currency: "INR",
          amount: applied.gatewayAmount,
          method,
          orderId: null,
          paymentId: String(paymentId),
          walletTxnId: result.debit ? String(result.debit._id) : null,
        },
  };
};

module.exports = { getWallet, claim, listPayments, pay, ledgerOf };
