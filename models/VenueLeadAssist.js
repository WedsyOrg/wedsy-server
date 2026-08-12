const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

/**
 * MB-OSV S0 — "Leads I'm on": the join recording that a venue-team admin is
 * assisting on a CRM couple-lead, usually to support a venue recommendation.
 *
 * WHY A JOIN AND NOT A FIELD ON Enquiry:
 * the CRM's Enquiry model is owned by the Sales team and is under a cross-team
 * lock. Venue-side involvement is a venue concern with a different lifecycle
 * (it starts and ends without the lead changing), so it lives in a
 * venue-owned collection. Nothing here writes to Enquiry — S5 reads lead data
 * through the CRM's own reads and joins on `enquiry`.
 */
const VenueLeadAssistSchema = new mongoose.Schema(
  {
    // The venue this admin is assisting ABOUT (the recommendation subject).
    venue: { type: ObjectId, ref: "Venue", required: true },
    // The Wedsy admin doing the assisting.
    adminId: { type: ObjectId, ref: "Admin", required: true },
    // The CRM couple-lead. Read-only from this side, always.
    enquiry: { type: ObjectId, ref: "Enquiry", required: true },
    role: {
      type: String,
      enum: ["recommending", "coordinating", "site_visit_host", "negotiating", "observer"],
      default: "recommending",
    },
    // Open assists are the working set; closing keeps the history without
    // deleting it (and without touching the lead).
    status: { type: String, enum: ["active", "closed"], default: "active" },
    notes: { type: String, default: "", maxlength: 2000 },
    closedAt: { type: Date },
  },
  { timestamps: true }
);

// One live assist per (admin, enquiry, venue) — re-assisting the same lead for
// the same venue is the same fact, not a second one.
VenueLeadAssistSchema.index(
  { adminId: 1, enquiry: 1, venue: 1 },
  { unique: true, partialFilterExpression: { status: "active" } }
);
VenueLeadAssistSchema.index({ adminId: 1, status: 1, createdAt: -1 });
VenueLeadAssistSchema.index({ venue: 1, status: 1 });

module.exports =
  mongoose.models.VenueLeadAssist ||
  mongoose.model("VenueLeadAssist", VenueLeadAssistSchema);
