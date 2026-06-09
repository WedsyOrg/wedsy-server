const mongoose = require("mongoose");

// Team activity log (who / what / when) for member management + member logins.
const VenueTeamActivitySchema = new mongoose.Schema(
  {
    venueId: { type: mongoose.Schema.Types.ObjectId, ref: "Venue", required: true },
    actorId: { type: String, default: "" }, // member or owner id (string, mixed actor types)
    actorName: { type: String, default: "" },
    action: { type: String, required: true }, // e.g. member_invited, member_deactivated, role_changed, member_login
    targetMemberId: { type: String, default: "" },
    detail: { type: String, default: "" },
  },
  { timestamps: true }
);

VenueTeamActivitySchema.index({ venueId: 1, createdAt: -1 });

module.exports =
  mongoose.models.VenueTeamActivity || mongoose.model("VenueTeamActivity", VenueTeamActivitySchema);
