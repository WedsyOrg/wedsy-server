const mongoose = require("mongoose");

// Per-lead communication log (Venue-Booking-owned). Kept separate from the shared
// VenueEnquiry so there is no OS schema coordination needed.
const VenueLeadInteractionSchema = new mongoose.Schema(
  {
    enquiry: { type: mongoose.Schema.Types.ObjectId, ref: "VenueEnquiry", required: true },
    venue: { type: mongoose.Schema.Types.ObjectId, ref: "Venue", required: true },
    type: {
      type: String,
      // MB-CRM S0e: "note" added for the quick-log free-text touch.
      enum: ["call", "whatsapp", "email", "site_visit", "meeting", "enquiry", "note"],
      required: true,
    },
    note: { type: String, default: "" },
    // WHO logged it. Deliberately un-ref'd: the actor may be the VenueOwner
    // anchor OR a VenueTeamMember, so a single ref would be a lie for half the
    // rows (and populate() would silently null them). createdByType says which
    // collection to resolve against; controllers/venueLeadInteraction resolves
    // the display name from both. Null for the auto-seeded "enquiry" row.
    createdBy: { type: mongoose.Schema.Types.ObjectId },
    createdByType: { type: String, enum: ["owner", "member"], default: "owner" },
    // MB-CRM S0a audit: how an auto-seeded assignment interaction arose, e.g.
    // "round_robin" | "create_override". Only stamped on assignment interactions.
    via: { type: String },
  },
  { timestamps: true }
);

VenueLeadInteractionSchema.index({ enquiry: 1, createdAt: -1 });

module.exports =
  mongoose.models.VenueLeadInteraction ||
  mongoose.model("VenueLeadInteraction", VenueLeadInteractionSchema);
