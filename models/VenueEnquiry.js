const mongoose = require("mongoose");

const VenueEnquirySchema = new mongoose.Schema(
  {
    venueId: { type: mongoose.Schema.Types.ObjectId, ref: "Venue", required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    name: { type: String, default: "" },
    phone: { type: String, default: "" },
    eventDate: { type: Date },
    guestCount: { type: Number },
    budget: { type: String },
    vibe: [{ type: String }],
    message: { type: String, default: "" },
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

module.exports = mongoose.models.VenueEnquiry || mongoose.model("VenueEnquiry", VenueEnquirySchema);
