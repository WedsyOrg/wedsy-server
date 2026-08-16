const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// MB-V2 P1 — minimal walk-through record so planner-scheduled site visits are
// trackable by both sides (full visit workflow stays future work). enquiryRef
// points at the owner-visible VenueEnquiry the D2 linkage guarantees.
const VenueSiteVisitSchema = new mongoose.Schema(
  {
    venue: { type: ObjectId, ref: "Venue", required: true },
    enquiryRef: { type: ObjectId, ref: "VenueEnquiry", required: true },
    scheduledAt: { type: Date, required: true },
    status: {
      type: String,
      enum: ["scheduled", "confirmed", "completed", "cancelled"],
      default: "scheduled",
    },
    notes: { type: String, default: "", maxlength: 2000 },
    // BUILD — a visit is the only next-step whose VALUE is entirely in what
    // happens after it, and until now the record could not hold that. `status`
    // is lifecycle (did the appointment happen) and answers a different
    // question from `outcome` (how did it GO) — "completed" and "no-show" are
    // not points on one scale, and "too expensive" is not a status at all.
    //
    // ADDITIVE ONLY: three optional fields with defaults. No existing field is
    // touched, no document needs migrating, and every current reader is
    // unaffected — a row without them behaves exactly as it does today.
    /** What to have ready, who's coming, what they care about. Written BEFORE. */
    prepNote: { type: String, default: "", maxlength: 2000 },
    /** How it went. null until someone logs it — the honest state. */
    outcome: {
      type: String,
      enum: ["came", "no_show", "went_well", "too_expensive", "other", null],
      default: null,
    },
    /** The detail behind the outcome, in the owner's words. */
    outcomeNote: { type: String, default: "", maxlength: 2000 },
    outcomeAt: { type: Date },
    createdByType: { type: String, enum: ["wedsy", "owner"], default: "wedsy" },
  },
  { timestamps: true }
);

VenueSiteVisitSchema.index({ venue: 1, scheduledAt: 1 });
VenueSiteVisitSchema.index({ status: 1, scheduledAt: 1 });

module.exports =
  mongoose.models.VenueSiteVisit ||
  mongoose.model("VenueSiteVisit", VenueSiteVisitSchema);
