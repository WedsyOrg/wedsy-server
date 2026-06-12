const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// A single venue page view. Public (anonymous) views are deduped per
// session/day via sessionHash — a server-side hash of IP+UA+slug+day. NO PII is
// stored (no raw IP/UA). Authenticated views additionally carry userId.
const VenueViewSchema = new mongoose.Schema(
  {
    userId: { type: ObjectId, ref: "User" }, // optional — anonymous views have none
    venueId: { type: ObjectId, ref: "Venue", required: true },
    venueSlug: { type: String },
    // sha256(ip + ua + slug + YYYY-MM-DD). Opaque, non-reversible, no PII.
    sessionHash: { type: String },
    // Coarse referrer class only (e.g. "direct", "search", "social", "internal").
    source: { type: String, default: "direct" },
    viewedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

VenueViewSchema.index({ userId: 1 });
VenueViewSchema.index({ venueId: 1, viewedAt: 1 });
VenueViewSchema.index({ venueId: 1, sessionHash: 1, viewedAt: 1 });

module.exports =
  mongoose.models.VenueView ||
  mongoose.model("VenueView", VenueViewSchema);
