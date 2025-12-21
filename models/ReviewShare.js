const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// Share-link tokens for collecting reviews from customers (no-login flow).
const ReviewShareSchema = new mongoose.Schema(
  {
    vendor: { type: ObjectId, ref: "Vendor", required: true, index: true },
    tokenHash: { type: String, required: true, index: true },
    active: { type: Boolean, default: true, index: true },
    name: { type: String, default: "" }, // optional label (e.g., "Dec 2025 campaign")
    createdBy: { type: ObjectId, default: null },
    createdByModel: { type: String, default: "" }, // "Vendor" | "Admin"
  },
  { timestamps: true }
);

ReviewShareSchema.index({ vendor: 1, tokenHash: 1 }, { unique: true });

module.exports = mongoose.model("ReviewShare", ReviewShareSchema);


