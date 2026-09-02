const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// An Instagram professional account that has authorised Wedsy OS through
// Instagram Login (Tech Provider model). ONE ROW PER ACCOUNT, by design: the
// only thing standing between "Wedsy's own inbox" and "a venue's own inbox" is
// another row here, so venues connecting their own accounts later is a data
// change, not a schema change.
//
// THIS COLLECTION IS THE TOKEN OF RECORD. utils/instagram.js resolves the
// access token from here, not from INSTAGRAM_AGENT_PAGE_ACCESS_TOKEN — the env
// var survives only as a one-deploy bootstrap fallback (see resolveAccessToken).
//
// Instagram Login has NO non-expiring token: a long-lived token lasts 60 days
// and must be rotated. utils/instagramTokenRefreshJob.js does that weekly, and
// accessToken/tokenExpiresAt/lastRefreshedAt are what it rotates and reads.
// A token that stops being refreshed is a dated outage — the inbox goes dark
// and Kiara stops answering DMs, silently.
const ConnectedInstagramAccountSchema = new mongoose.Schema(
  {
    // The real Instagram account id (Graph `user_id`), NOT the app-scoped `id`.
    instagramUserId: { type: String, required: true, unique: true, index: true },
    username: { type: String, required: true },
    // Long-lived token (~60d). Rotated in place by the refresh job — every
    // refresh returns a NEW token and invalidates nothing else, so this field
    // is the single live credential for the account.
    accessToken: { type: String, required: true },
    tokenExpiresAt: { type: Date, required: true },
    // Last SUCCESSFUL refresh. Doubles as the "consecutive failures since"
    // watermark the refresh job counts from — see countFailuresSinceLastSuccess.
    lastRefreshedAt: { type: Date, default: null },
    status: { type: String, enum: ["active", "revoked"], default: "active" },

    // ── Tenancy (Venue Booking amendment) ──────────────────────────────────
    // WHO OWNS THIS HANDLE. Multi-account without this is not multi-tenant: two
    // rows, and nothing saying which venue either belongs to. It is one field
    // now and an awkward backfill once there are rows, so it goes in now even
    // though nothing reads it yet.
    //
    // null means Wedsy's own account — the only kind that exists today.
    //
    // SHAPE ONLY, DELIBERATELY. utils/instagram.js still resolves a single
    // active account and does NOT filter on this. A tenant-aware selector
    // ("the active account for venue X") is a later change; the point here is
    // merely that the schema does not preclude one.
    venue: { type: ObjectId, ref: "Venue", default: null, index: true },

    // Read back off the OAuth state record at /callback time — that route is
    // unauthenticated (Meta redirects the browser to it), so it cannot learn
    // who is connecting any other way.
    //
    // NO `ref` ON PURPOSE. This was specced as ref:"Admin", but a venue owner
    // connecting through the owner portal is a VenueOwner or a VenueTeamMember
    // and would have nowhere to live. The id is therefore untyped and
    // connectedByType below says which collection to read it from.
    connectedBy: { type: ObjectId, default: null },
    connectedByType: {
      type: String,
      enum: ["admin", "venueOwner", "venueMember"],
      default: null,
    },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.ConnectedInstagramAccount ||
  mongoose.model("ConnectedInstagramAccount", ConnectedInstagramAccountSchema);
