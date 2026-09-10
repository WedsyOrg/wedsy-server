const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;
const { CONTRIBUTION_MODE } = require("../utils/coupleEnums");

// COUPLE APP § 06.1 / § 06.3 — A GUEST'S GIFT, and the FIRST HALF of the one
// ledger the registry, the wallet and payments are three views of.
//
// § 06.3: "every contribution credits the Wallet" — and the credit is written
// in the SAME transaction as this row, not by a job afterwards. `walletTxn`
// points at that credit; a Contribution with a null walletTxn is money the
// couple cannot see, which is the exact failure the rule exists to forbid.
//
// `thanked` lives HERE, not on RegistryItem as § 06.1 sketched: one gift can
// carry contributions from several people and the couple thanks people. Named
// in the client's M4 hand-off (lib/plan/api.js → thankContribution).
const ContributionSchema = new mongoose.Schema(
  {
    weddingId: { type: ObjectId, ref: "Event", required: true, index: true },

    // Exactly one of the two is set — enforced in the service, because a
    // schema cannot express "exactly one of these" without a validator that
    // would also fire on every unrelated partial update.
    item: { type: ObjectId, ref: "RegistryItem", default: null, index: true },
    fund: { type: ObjectId, ref: "RegistryFund", default: null, index: true },

    // The guest is a stranger with no account. Name and phone are what they
    // typed; phoneNormalised is utils/phone's form, so a guest who also sits on
    // the guest list can be recognised without a second phone rule.
    guestName: { type: String, default: "", trim: true, maxlength: 120 },
    guestPhone: { type: String, default: "", trim: true, maxlength: 30 },
    guestPhoneNormalised: { type: String, default: "", index: true },
    note: { type: String, default: "", maxlength: 1000 },

    // Rupees. RE-DERIVED SERVER-SIDE for mode "full" (price minus what is
    // already funded) — never the figure the browser sent.
    amount: { type: Number, required: true, min: 1 },
    mode: { type: String, enum: CONTRIBUTION_MODE, required: true },

    // "pending" is a gateway intent that has not settled; only "settled" rows
    // count toward funded/raised and toward the wallet balance.
    status: { type: String, enum: ["pending", "settled", "failed", "refunded"], default: "pending", index: true },
    settledAt: { type: Date, default: null },

    // The wallet credit written with this row (§ 06.3). Set in the same
    // transaction; null only while the row is still an unpaid intent.
    walletTxn: { type: ObjectId, ref: "WalletTxn", default: null },

    thanked: { type: Boolean, default: false },
    thankedAt: { type: Date, default: null },

    // Gateway provenance, for the reconciliation the money team will ask for.
    gatewayRef: { type: String, default: "" },
  },
  { timestamps: true }
);

// The thank-you list, and the couple's registry read.
ContributionSchema.index({ weddingId: 1, createdAt: -1 });
ContributionSchema.index({ weddingId: 1, thanked: 1 });

module.exports = mongoose.models.Contribution || mongoose.model("Contribution", ContributionSchema);
