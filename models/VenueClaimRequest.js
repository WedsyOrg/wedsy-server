const mongoose = require("mongoose");

const VenueClaimRequestSchema = new mongoose.Schema(
  {
    venueId: { type: mongoose.Schema.Types.ObjectId, ref: "Venue", required: true },
    venueName: { type: String, required: true },
    venueSlug: { type: String, required: true },
    name: { type: String, required: true },
    designation: { type: String, enum: ["owner", "manager", "marketing"], default: "owner" },
    phone: { type: String, required: true },
    email: { type: String, required: true },
    howHeard: { type: String, default: "" },
    message: { type: String, default: "" },
    tier: { type: String, enum: ["phone_mismatch", "document_failed", "no_phone"], default: "phone_mismatch" },
    status: {
      type: String,
      enum: ["pending_manual_review", "approved", "rejected"],
      default: "pending_manual_review",
    },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
    reviewedAt: { type: Date },
    reviewNote: { type: String, default: "" },
  },
  { timestamps: true }
);

VenueClaimRequestSchema.index({ venueId: 1 });
VenueClaimRequestSchema.index({ status: 1 });
VenueClaimRequestSchema.index({ phone: 1 });

module.exports = mongoose.model("VenueClaimRequest", VenueClaimRequestSchema);
