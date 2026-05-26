const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

const VenueViewSchema = new mongoose.Schema(
  {
    userId: { type: ObjectId, ref: "User", required: true },
    venueId: { type: ObjectId, ref: "Venue", required: true },
    venueSlug: { type: String },
    viewedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

VenueViewSchema.index({ userId: 1 });
VenueViewSchema.index({ venueId: 1 });
VenueViewSchema.index({ userId: 1, venueId: 1, viewedAt: 1 });

module.exports =
  mongoose.models.VenueView ||
  mongoose.model("VenueView", VenueViewSchema);
