const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;
const { ACCESS_LEVEL, RELATIONS } = require("../utils/coupleEnums");

// COUPLE APP § 06.1 / § 06.4 — FAMILY SHARING. One person the couple let into
// part of their wedding, and the record the server enforces on every single
// couple-app request.
//
// This is NOT LeadTeamMember or VenueTeamMember: those are Wedsy staff on a
// lead or a venue, keyed to an Admin. This is the bride's mother, with a User
// account of her own and access to two sections of one wedding.
//
// § 06.4: "hiding UI is a convenience, not a control". Everything the client
// does with this document is presentation; middlewares/coupleAuth is the
// control, and it reads this row on every request.
const AccessSchema = new mongoose.Schema(
  {
    guests: { type: String, enum: ACCESS_LEVEL, default: "view" },
    website: { type: String, enum: ACCESS_LEVEL, default: "none" },
    decor: { type: String, enum: ACCESS_LEVEL, default: "none" },
    registry: { type: String, enum: ACCESS_LEVEL, default: "none" },
    payments: { type: String, enum: ACCESS_LEVEL, default: "none" },
    tasks: { type: String, enum: ACCESS_LEVEL, default: "none" },
  },
  { _id: false }
);

const SharedMemberSchema = new mongoose.Schema(
  {
    weddingId: { type: ObjectId, ref: "Event", required: true, index: true },

    // Null until they open the invite and their phone resolves to a User. An
    // unaccepted member has no account attached and therefore no way in — the
    // membership test is `user`, never `phone`.
    user: { type: ObjectId, ref: "User", default: null, index: true },

    name: { type: String, required: true, trim: true, maxlength: 120 },
    phone: { type: String, default: "", trim: true, maxlength: 30 },
    phoneNormalised: { type: String, default: "", index: true },

    // One of the 17 presets, or the couple's own words. Free text on purpose:
    // a relation nobody anticipated must not block an invitation.
    relation: { type: String, default: "", trim: true, maxlength: 80 },

    // THE SIX SECTIONS AND NOTHING ELSE. There is no seventh key for payouts,
    // by design: see services/CouplePermissions.js — the right to move money is
    // not expressible in this document, so no configuration of it can grant it.
    access: { type: AccessSchema, default: () => ({}) },

    invitedAt: { type: Date, default: Date.now },
    acceptedAt: { type: Date, default: null },
    invitedBy: { type: ObjectId, ref: "User", default: null },

    // The one-time credential in the invite link. Hashed, never the raw token.
    inviteTokenHash: { type: String, default: "", select: false },

    // Removal is a stamp, not a delete: their Activity rows still name them,
    // and a revoked member must stop resolving immediately.
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// The membership test on every request: this wedding, this user, live.
SharedMemberSchema.index({ weddingId: 1, user: 1 });
// The members list.
SharedMemberSchema.index({ weddingId: 1, createdAt: 1 });

// Exported for the invite screen's preset list; the schema itself does not
// constrain `relation` to it (see the field comment above).
SharedMemberSchema.statics.RELATION_PRESETS = RELATIONS;

module.exports = mongoose.models.SharedMember || mongoose.model("SharedMember", SharedMemberSchema);
