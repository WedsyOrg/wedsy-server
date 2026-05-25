const mongoose = require("mongoose");

const VenueEnquirySchema = new mongoose.Schema(
  {
    venueId: { type: mongoose.Schema.Types.ObjectId, ref: "Venue", required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    name: { type: String, default: "" },
    phone: { type: String, default: "" },
    coupleName: { type: String, default: "" },
    couplePhone: { type: String, default: "" },
    eventDate: { type: Date },
    guestCount: { type: Number },
    budget: { type: String },
    vibe: [{ type: String }],
    message: { type: String, default: "" },
    source: {
      type: String,
      enum: ["wedsy", "instagram", "referral", "walk_in", "justdial", "wedmegood", "other"],
      default: "wedsy",
    },
    stage: {
      type: String,
      enum: ["new", "contacted", "site_visit", "negotiation", "booked", "lost"],
      default: "new",
    },
    estimatedValue: { type: Number, default: 0 },
    lostReason: { type: String, default: "" },
    followUpDate: { type: Date },
    notes: [{ text: String, addedAt: { type: Date, default: Date.now } }],
    activities: [{ type: { type: String }, description: String, timestamp: { type: Date, default: Date.now } }],
    status: {
      type: String,
      enum: ["new", "contacted", "site_visit_scheduled", "negotiating", "booked", "lost"],
      default: "new",
    },
    outreachSentAt: { type: Date },
    outreachChannel: { type: String },
    followUp24hSentAt: { type: Date },
    followUp48hSentAt: { type: Date },
  },
  { timestamps: true }
);

VenueEnquirySchema.index({ venueId: 1 });
VenueEnquirySchema.index({ userId: 1 });
VenueEnquirySchema.index({ venueId: 1, stage: 1 });
VenueEnquirySchema.index({ venueId: 1, source: 1 });

module.exports = mongoose.models.VenueEnquiry || mongoose.model("VenueEnquiry", VenueEnquirySchema);
