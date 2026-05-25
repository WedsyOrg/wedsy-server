const mongoose = require("mongoose");

const VenueOwnerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    email: { type: String, trim: true, default: "" },
    role: {
      type: String,
      enum: ["owner", "manager", "marketing"],
      default: "owner",
    },
    venueId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Venue",
      required: true,
    },
    verificationStatus: {
      type: String,
      enum: ["pending", "phone_verified", "verified"],
      default: "pending",
    },
    claimedAt: { type: Date },
    lastLoginAt: { type: Date },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

VenueOwnerSchema.index({ phone: 1 });
VenueOwnerSchema.index({ venueId: 1 });

module.exports = mongoose.model("VenueOwner", VenueOwnerSchema);
