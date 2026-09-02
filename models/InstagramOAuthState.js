const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// The CSRF `state` for one in-flight Instagram OAuth authorisation.
//
// WHY THIS COLLECTION EXISTS AT ALL, beyond CSRF: /callback is UNAUTHENTICATED.
// Meta redirects the user's browser to it cross-site, so no session cookie
// arrives and the route cannot know who is connecting. The acting admin is
// therefore stamped here at /connect time, while the request is still authed,
// and read back at /callback to populate ConnectedInstagramAccount.connectedBy.
// Putting auth on /callback instead would simply break the flow.
//
// SINGLE USE. consumedAt is set by an atomic findOneAndUpdate on the first
// callback; a second callback with the same state matches nothing and is
// rejected. Missing, unknown and reused states are all the same answer.
const InstagramOAuthStateSchema = new mongoose.Schema(
  {
    state: { type: String, required: true, unique: true, index: true },
    // The actor, captured while the request is still authenticated. Untyped id
    // + a type tag, matching ConnectedInstagramAccount: the same flow has to
    // carry an Admin, a VenueOwner or a VenueTeamMember.
    adminId: { type: ObjectId, default: null },
    connectedByType: {
      type: String,
      enum: ["admin", "venueOwner", "venueMember"],
      default: null,
    },
    // The venue whose handle is being connected — null for Wedsy's own account.
    // Carried here for exactly the reason the actor is: /callback is
    // unauthenticated and cannot re-derive it from a token.
    venue: { type: ObjectId, ref: "Venue", default: null },
    consumedAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

// TTL: Mongo deletes each record ~10 minutes after creation, so this collection
// self-cleans and an abandoned authorisation cannot be resumed later. The
// window is deliberately short — it only has to span one browser round trip
// through Instagram's consent screen.
//
// NOTE: expireAfterSeconds is fixed at index-creation time. Changing the number
// below on an existing deployment requires dropping the index for Mongo to pick
// up the new value (collMod, or drop + let Mongoose rebuild).
InstagramOAuthStateSchema.index({ createdAt: 1 }, { expireAfterSeconds: 600 });

module.exports =
  mongoose.models.InstagramOAuthState ||
  mongoose.model("InstagramOAuthState", InstagramOAuthStateSchema);
