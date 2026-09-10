const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;
const { WALLET_TXN_TYPE, WALLET_TXN_STATUS } = require("../utils/coupleEnums");

// COUPLE APP § 06.1 / § 06.3 — THE WEDSY WALLET, as an APPEND-ONLY LEDGER.
//
// There is no balance field anywhere. The balance is Σ credits − Σ debits and
// claims over the settled rows (services/CoupleWalletService.balance), because
// a stored balance and a ledger are two numbers that will eventually disagree,
// and the one that disagrees is the couple's money.
//
// § 06.1 names two types. There are four real movements:
//   credit   a contribution arrived            (+)  ← written WITH the Contribution
//   debit    the balance was applied as an offset in the Pay flow   (−)
//   claim    the couple moved money to their bank (−)
//   reversal a failed claim came back           (+)
// Only rows with status "settled" count toward the balance; a claim sits
// "pending" for the 2–3 working days § 05.1 promises.
const WalletTxnSchema = new mongoose.Schema(
  {
    weddingId: { type: ObjectId, ref: "Event", required: true, index: true },
    type: { type: String, enum: WALLET_TXN_TYPE, required: true },
    // Always POSITIVE. The sign is the type's job — a negative amount on a
    // credit row is a bug that reads as a refund and sums as one.
    amount: { type: Number, required: true, min: 0 },
    status: { type: String, enum: WALLET_TXN_STATUS, default: "settled" },

    // What moved the money. Exactly one of these is set for credit/debit rows.
    contribution: { type: ObjectId, ref: "Contribution", default: null },
    payment: { type: ObjectId, ref: "Payment", default: null },

    label: { type: String, default: "", maxlength: 200 },   // what the couple reads
    ref: { type: String, default: "", maxlength: 120 },      // "2–3 working days", a UTR, …

    // A CLAIM AND A DEBIT ARE PARTNER-ONLY ACTS. This is the id of the User who
    // initiated it, and it can only ever be a partner: a SharedMember with
    // payments "edit" cannot reach the routes that write these rows
    // (services/CouplePermissions — payouts are not a grantable section).
    initiatedBy: { type: ObjectId, ref: "User", default: null },

    settledAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// The ledger read: one wedding, newest first.
WalletTxnSchema.index({ weddingId: 1, createdAt: -1 });
// The balance sum walks only the settled rows.
WalletTxnSchema.index({ weddingId: 1, status: 1 });

module.exports = mongoose.models.WalletTxn || mongoose.model("WalletTxn", WalletTxnSchema);
