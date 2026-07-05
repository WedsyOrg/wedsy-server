const mongoose = require("mongoose");

const VenueEnquirySchema = new mongoose.Schema(
  {
    venueId: { type: mongoose.Schema.Types.ObjectId, ref: "Venue", required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    name: { type: String, default: "" },
    phone: { type: String, default: "" },
    coupleName: { type: String, default: "" },
    couplePhone: { type: String, default: "" },
    email: { type: String, default: "" },
    eventDate: { type: Date },
    guestCount: { type: Number },
    budget: { type: String },
    vibe: [{ type: String }],
    message: { type: String, default: "" },
    source: {
      type: String,
      enum: ["wedsy", "instagram", "referral", "walk_in", "justdial", "wedmegood", "google", "other"],
      default: "wedsy",
    },
    stage: {
      type: String,
      enum: [
        "new",
        "contacted",
        "site_visit_scheduled",
        "site_visit_done",
        "proposal_sent",
        "negotiating",
        "booked",
        "lost",
      ],
      default: "new",
    },
    estimatedValue: { type: Number, default: 0 },
    // Phase 3 (3.x): structured lost reason. "" allowed (legacy/none) so the
    // pre-existing free-text String data never fails validation on save.
    lostReason: {
      type: String,
      enum: ["", "too_expensive", "date_unavailable", "chose_competitor", "no_response", "other"],
      default: "",
    },
    followUpDate: { type: Date },
    assignedTo: { type: String, default: "" },
    // MB-V2 P1 (D2, additive): when the Wedsy planner's first venue-touching
    // action creates this owner-visible lead, this carries the CRM lead's id
    // (plain string — the CRM engine is a separate model space).
    crmLeadRef: { type: String, default: "" },
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
