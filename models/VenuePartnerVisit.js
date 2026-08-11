const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

/**
 * MB-OSV S0 — a Wedsy person physically visiting a venue to work the
 * PARTNERSHIP (Track B): pitch, negotiate terms, collect paperwork, check in on
 * a live partner.
 *
 * DELIBERATELY NOT VenueSiteVisit. That model is couple-facing: a walk-through
 * booked for a specific couple against a specific VenueEnquiry, visible to the
 * venue, and it advances the couple's lead stage. This one is internal, has no
 * couple, is never shown to the venue, and moves nothing in the couple funnel.
 * Conflating them would put Wedsy's commercial calls into a couple's timeline.
 */
const VenuePartnerVisitSchema = new mongoose.Schema(
  {
    venue: { type: ObjectId, ref: "Venue", required: true },
    // The Wedsy admin who went. Always an Admin — never a VenueOwner/member.
    visitedBy: { type: ObjectId, ref: "Admin", required: true },
    visitedAt: { type: Date, required: true },
    outcome: {
      type: String,
      enum: ["pitched", "interested", "not_interested", "signed", "follow_up", "no_show", "other"],
      default: "pitched",
    },
    notes: { type: String, default: "", maxlength: 4000 },
    // Free text rather than a task ref: the follow-up is usually a sentence
    // ("call the owner's brother, he decides"), not a schedulable object.
    nextAction: { type: String, default: "", maxlength: 1000 },
  },
  { timestamps: true }
);

VenuePartnerVisitSchema.index({ venue: 1, visitedAt: -1 });
VenuePartnerVisitSchema.index({ visitedBy: 1, visitedAt: -1 });

module.exports =
  mongoose.models.VenuePartnerVisit ||
  mongoose.model("VenuePartnerVisit", VenuePartnerVisitSchema);
