const mongoose = require("mongoose");

const VenueSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true },
    address: { type: String, default: "Bangalore" },
    city: { type: String, default: "Bangalore" },
    location: {
      type: { type: String },
      coordinates: { type: [Number] },
    },
    venueType: {
      type: String,
      enum: ["resort", "farmhouse", "villa", "hotel", "other"],
      default: "resort",
    },
    capacity: {
      min: { type: Number, default: 0 },
      max: { type: Number, default: 0 },
    },
    accommodation: {
      available: { type: Boolean, default: false },
      rooms: { type: Number, default: 0 },
      description: { type: String, default: "" },
    },
    spaces: [
      {
        name: String,
        type: { type: String, enum: ["indoor", "outdoor", "semi-outdoor"] },
        capacity: Number,
        description: String,
      },
    ],
    amenities: [{ type: String }],
    catering: {
      type: String,
      enum: ["in_house_only", "outside_allowed", "both", "unknown"],
      default: "unknown",
    },
    pricing: {
      currency: { type: String, default: "INR" },
      note: { type: String, default: "" },
    },
    photos: [{ type: String }],
    coverPhoto: { type: String, default: "" },
    phone: { type: String, default: "" },
    email: { type: String, default: "" },
    website: { type: String, default: "" },
    googlePlaceId: { type: String, default: "" },
    googleRating: { type: Number, default: null },
    googleReviewCount: { type: Number, default: null },
    scrapedFrom: [{ type: String }],
    description: { type: String, default: "" },
    seoKeywords: [{ type: String }],
    dataCompleteness: { type: Number, default: 1 },
    status: {
      type: String,
      enum: ["draft", "published", "pending_outreach", "outreach_sent", "verified", "rejected"],
      default: "draft",
    },
    outreachSentAt: { type: Date },
    outreachChannel: { type: String },
    vendorId: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor" },
    enquiries: [{ type: mongoose.Schema.Types.ObjectId, ref: "VenueEnquiry" }],
    blockedDates: [{ type: String }],
  },
  { timestamps: true }
);

VenueSchema.index({ location: "2dsphere" }, { sparse: true });
VenueSchema.index({ slug: 1 });
VenueSchema.index({ status: 1 });
VenueSchema.index({ city: 1, venueType: 1 });

module.exports = mongoose.model("Venue", VenueSchema);
