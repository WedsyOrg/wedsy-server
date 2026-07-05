const mongoose = require("mongoose");
const { CAPABILITIES_V2 } = require("../utils/venueRoles");

// RBAC v2 (D5): an owner-editable capability bundle, scoped to one venue.
// Four defaults are seeded on first touch (Manager / Sales / Front Desk /
// Accounts) plus the immutable system Owner role. Members point here via
// VenueTeamMember.roleRef; the legacy 5-enum role string stays on the member
// as a fallback so pre-v2 tokens and unmigrated members keep working.
const VenueRoleSchema = new mongoose.Schema(
  {
    venue: { type: mongoose.Schema.Types.ObjectId, ref: "Venue", required: true },
    name: { type: String, required: true, trim: true },
    capabilities: [{ type: String, enum: CAPABILITIES_V2 }],
    // Seeded starter bundle (owner may edit or delete when memberless).
    isDefault: { type: Boolean, default: false },
    // The Owner role: immutable, every capability, never deletable.
    isSystem: { type: Boolean, default: false },
  },
  { timestamps: true }
);

VenueRoleSchema.index({ venue: 1, name: 1 }, { unique: true });

module.exports = mongoose.models.VenueRole || mongoose.model("VenueRole", VenueRoleSchema);
