const mongoose = require("mongoose");
const { VENUE_ROLES } = require("../utils/venueRoles");

// A team member under a venue. VenueOwner remains the account anchor (claim/OTP/
// verification lifecycle); members are additional logins scoped to the same venue.
// NOTE: provisional shape — a shared contract pending OS sign-off on Owner-tab /
// impersonation.
const VenueTeamMemberSchema = new mongoose.Schema(
  {
    venueId: { type: mongoose.Schema.Types.ObjectId, ref: "Venue", required: true },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "VenueOwner" }, // anchor account
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    email: { type: String, trim: true, default: "" },
    role: { type: String, enum: VENUE_ROLES, default: "sales" },
    isActive: { type: Boolean, default: true },
    // Actor (owner or member) id that invited this member; not a strict ref since the
    // actor may be either type.
    invitedBy: { type: mongoose.Schema.Types.ObjectId },
    lastLoginAt: { type: Date },
  },
  { timestamps: true }
);

VenueTeamMemberSchema.index({ venueId: 1, phone: 1 }, { unique: true });
VenueTeamMemberSchema.index({ phone: 1 });

module.exports =
  mongoose.models.VenueTeamMember || mongoose.model("VenueTeamMember", VenueTeamMemberSchema);
