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
    email: { type: String, trim: true, lowercase: true, default: "" },
    // Legacy 5-enum role — kept as the fallback for pre-RBAC-v2 tokens and
    // unmigrated members. New resolution goes through roleRef (VenueRole).
    role: { type: String, enum: VENUE_ROLES, default: "sales" },
    // RBAC v2 (D5): the owner-editable capability bundle this member holds.
    roleRef: { type: mongoose.Schema.Types.ObjectId, ref: "VenueRole" },
    // Email+password member login (owner auth stays phone OTP). Never selected
    // by default; login code opts in explicitly.
    passwordHash: { type: String, default: "", select: false },
    // The owner's OWN member row (utils/venueOwnerMember). It exists so the owner
    // can be assigned leads/tasks/follow-ups like anyone else — it is NOT a login
    // identity: it never carries an email or a passwordHash, and every member
    // login lane (collectIdentities / send-otp / member-auth / select-identity)
    // filters it out. The owner still signs in as an owner, via phone OTP.
    isOwnerAccount: { type: Boolean, default: false },
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
// Email is the member-login key: unique per venue, but only when set — legacy
// members with empty emails must not collide (partial index, additive).
VenueTeamMemberSchema.index(
  { venueId: 1, email: 1 },
  { unique: true, partialFilterExpression: { email: { $gt: "" } } }
);
VenueTeamMemberSchema.index({ email: 1 });
// The owner-account lookup runs on every "Me" resolution — keep it indexed.
VenueTeamMemberSchema.index({ venueId: 1, isOwnerAccount: 1 });

module.exports =
  mongoose.models.VenueTeamMember || mongoose.model("VenueTeamMember", VenueTeamMemberSchema);
