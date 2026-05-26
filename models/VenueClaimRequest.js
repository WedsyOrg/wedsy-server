const mongoose = require("mongoose");

const VenueClaimRequestSchema = new mongoose.Schema(
  {
    // For claims against existing venues these are populated. For self
    // sign-ups where the venue is not yet in the database they are left blank
    // and the newVenue* fields below capture the proposed listing instead.
    venueId: { type: mongoose.Schema.Types.ObjectId, ref: "Venue" },
    venueName: { type: String },
    venueSlug: { type: String },
    // Self sign-up fields — populated when a venue owner submits a brand-new
    // listing that doesn't exist in the Venue collection yet.
    newVenueName: { type: String },
    newVenueType: { type: String },
    newVenueAddress: { type: String },
    name: { type: String, required: true },
    designation: { type: String, enum: ["owner", "manager", "marketing"], default: "owner" },
    phone: { type: String, required: true },
    email: { type: String, required: true },
    howHeard: { type: String, default: "" },
    message: { type: String, default: "" },
    tier: {
      type: String,
      enum: ["phone_mismatch", "document_failed", "no_phone", "new_venue_signup"],
      default: "phone_mismatch",
    },
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
