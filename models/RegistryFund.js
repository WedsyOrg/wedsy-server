const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// COUPLE APP § 06.1 / § 05.1 — A CASH FUND: a named goal with a target
// ("Kyoto honeymoon, ₹80,000") that guests contribute amounts to rather than
// buying a thing.
//
// Separate from RegistryItem rather than a flag on it, because the two behave
// differently everywhere that matters: an item can be fully funded and then
// bought out (§ 05.1's "already_funded" 409), a fund cannot be over-subscribed
// into an error — money past the target is still welcome. `raised` is the same
// kind of denormalised running total as RegistryItem.funded, written in the
// contribution's transaction.
const RegistryFundSchema = new mongoose.Schema(
  {
    weddingId: { type: ObjectId, ref: "Event", required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    image: { type: String, default: "" },
    target: { type: Number, default: 0, min: 0 },  // rupees
    raised: { type: Number, default: 0, min: 0 },  // Σ settled contributions, denormalised
    sortOrder: { type: Number, default: 0 },
    archivedAt: { type: Date, default: null },
    createdBy: { type: ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

RegistryFundSchema.index({ weddingId: 1, sortOrder: 1 });

module.exports = mongoose.models.RegistryFund || mongoose.model("RegistryFund", RegistryFundSchema);
