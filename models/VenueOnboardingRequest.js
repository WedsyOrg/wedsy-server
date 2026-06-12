const mongoose = require("mongoose");

// A "list your venue" lead from the public landing page. Venue-owned, no auth —
// captured via the public rate-limited endpoint; the team follows up offline.
const VenueOnboardingRequestSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    venueName: { type: String, required: true, trim: true },
    city: { type: String, default: "", trim: true },
    phone: { type: String, required: true, trim: true },
    status: { type: String, enum: ["new", "contacted", "converted", "dropped"], default: "new" },
  },
  { timestamps: true }
);

VenueOnboardingRequestSchema.index({ status: 1, createdAt: -1 });
VenueOnboardingRequestSchema.index({ phone: 1 });

module.exports =
  mongoose.models.VenueOnboardingRequest ||
  mongoose.model("VenueOnboardingRequest", VenueOnboardingRequestSchema);
