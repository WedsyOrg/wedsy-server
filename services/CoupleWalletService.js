/* INVARIANT 2 of 4 — REGISTRY → WALLET → PAYMENTS (§ 06.3).
 *
 *   "Every contribution credits the Wallet. The Wallet balance is offered as an
 *    offset in the Pay modal. Claiming debits it. Three screens, one ledger."
 *
 * The three screens are the registry, the wallet strip and Payments. The one
 * ledger is models/WalletTxn — append-only, no stored balance, because a stored
 * balance and a ledger are two numbers that will eventually disagree and the
 * one that disagrees is the couple's money.
 *
 * PURE. Every function here takes plain objects and returns plain objects: the
 * documents to write and the amounts to write on them. The controller does the
 * writing, inside ONE transaction (see docs/couple-app-api.md) — this file is
 * where the arithmetic is, so the arithmetic can be tested without a database.
 *
 * ── THE RULE THAT MATTERS MOST ─────────────────────────────────────────────
 * `POST /payments/:id/pay` takes `useWallet` as a BOOLEAN. The offset is the
 * server's to compute, from the balance it holds at the moment of the write.
 * A client-supplied figure would be a client-authored debit, and applyWallet()
 * below has no parameter it could arrive in.
 */

const SETTLED = "settled";

/** Rupees, defensively: a non-number is 0, never NaN propagating into a total. */
const money = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/** Does this row move the balance? Only settled rows do. */
const isSettled = (txn) => Boolean(txn) && (txn.status || SETTLED) === SETTLED;

/** + for money arriving, − for money leaving. The type carries the sign. */
const signOf = (txn) => {
  switch (txn && txn.type) {
    case "credit":
    case "reversal":
      return 1;
    case "debit":
    case "claim":
      return -1;
    default:
      return 0; // an unknown type moves nothing rather than guessing a direction
  }
};

/**
 * The balance: Σ settled credits and reversals − Σ settled debits and claims.
 * Never negative — a ledger that sums below zero is a bug, and reporting it as
 * a negative balance would offer the couple a debt as an offset.
 */
const balance = (txns) => {
  const rows = Array.isArray(txns) ? txns : [];
  const sum = rows.reduce(
    (total, txn) => (isSettled(txn) ? total + signOf(txn) * money(txn.amount) : total),
    0
  );
  return sum > 0 ? sum : 0;
};

/**
 * How much a "pay in full" actually costs RIGHT NOW.
 *
 * § 06.3: re-derived server-side, so two guests both choosing "in full" at the
 * same moment cannot both succeed — the second one's re-derivation is 0 and the
 * caller turns that into the 409 `already_funded` the client expects.
 *
 * @param {object} gift    a RegistryItem ({price, funded}) or RegistryFund ({target, raised})
 * @param {string} mode    "full" | "part"
 * @param {number} asked   what the guest typed (used for "part" only)
 */
const contributionAmount = (gift, mode, asked) => {
  const g = gift || {};
  const isFund = g.target !== undefined || g.raised !== undefined;
  const price = money(isFund ? g.target : g.price);
  const already = money(isFund ? g.raised : g.funded);

  if (mode === "full") {
    // A FUND is a goal, not a price: "in full" means the rest of the goal, and
    // a fund past its target still accepts money — it is simply already met.
    const remaining = price - already;
    return remaining > 0 ? remaining : 0;
  }
  return money(asked);
};

/**
 * The two writes a settled contribution makes, as plain documents.
 *
 * THEY ARE RETURNED TOGETHER ON PURPOSE. The caller writes both in one
 * transaction; a Contribution without its WalletTxn is money the couple cannot
 * see, which is the exact failure § 06.3 exists to forbid.
 */
const contributionWrites = ({ weddingId, gift, giftType, mode, amount, guest }) => {
  const value = money(amount);
  const who = (guest && guest.name) || "A guest";
  return {
    contribution: {
      weddingId,
      item: giftType === "item" ? (gift && gift._id) || null : null,
      fund: giftType === "fund" ? (gift && gift._id) || null : null,
      guestName: (guest && guest.name) || "",
      guestPhone: (guest && guest.phone) || "",
      guestPhoneNormalised: (guest && guest.phoneNormalised) || "",
      note: (guest && guest.note) || "",
      amount: value,
      mode,
      status: SETTLED,
      settledAt: new Date(),
    },
    walletTxn: {
      weddingId,
      type: "credit",
      amount: value,
      status: SETTLED,
      label: `${who} — ${(gift && gift.title) || "a gift"}`,
      settledAt: new Date(),
    },
    // What the denormalised running total on the gift moves by, so the caller
    // does an $inc rather than a read-modify-write it could lose a race on.
    giftIncrement: value,
  };
};

/**
 * THE PAY-FLOW OFFSET.
 *
 * @param {number}  amountDue  what the payment row is for, in rupees
 * @param {number}  walletBalance  the balance this instant (from balance())
 * @param {boolean} useWallet  the client's BOOLEAN — the only thing it gets a say in
 * @returns {{walletApplied:number, gatewayAmount:number, fullyCovered:boolean}}
 *
 * There is deliberately no `amount` parameter. The offset is min(balance, due),
 * and when it covers the whole row the gateway is not involved at all.
 */
const applyWallet = (amountDue, walletBalance, useWallet) => {
  const due = money(amountDue);
  const available = money(walletBalance);
  const walletApplied = useWallet === true ? Math.min(available, due) : 0;
  const gatewayAmount = due - walletApplied;
  return { walletApplied, gatewayAmount, fullyCovered: walletApplied > 0 && gatewayAmount === 0 };
};

/** The debit row a wallet-offset payment writes. Amount always positive. */
const debitWrite = ({ weddingId, paymentId, amount, label, initiatedBy }) => ({
  weddingId,
  type: "debit",
  amount: money(amount),
  status: SETTLED,
  payment: paymentId || null,
  label: label || "Applied to a payment",
  initiatedBy: initiatedBy || null,
  settledAt: new Date(),
});

/**
 * A claim to the couple's bank. Refuses more than the balance, and refuses zero
 * — both as a value, not an exception, so the controller can turn either into
 * the 422 the client renders.
 *
 * Sits "pending" for the 2–3 working days § 05.1 promises, so it leaves the
 * balance the moment it is requested and does not come back unless it fails.
 */
const claimWrite = ({ weddingId, amount, walletBalance, initiatedBy }) => {
  const available = money(walletBalance);
  // No amount named = claim everything. That is what the button says it does.
  const asked = amount === undefined || amount === null ? available : money(amount);
  if (asked <= 0) return { ok: false, error: "nothing_to_claim", available };
  if (asked > available) return { ok: false, error: "insufficient_balance", available, asked };
  return {
    ok: true,
    txn: {
      weddingId,
      type: "claim",
      amount: asked,
      status: "pending",
      label: "Claim to your bank account",
      ref: "2–3 working days",
      initiatedBy: initiatedBy || null,
    },
  };
};

module.exports = {
  balance,
  isSettled,
  signOf,
  money,
  contributionAmount,
  contributionWrites,
  applyWallet,
  debitWrite,
  claimWrite,
};
