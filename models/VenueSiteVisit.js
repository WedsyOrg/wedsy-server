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
    createdByType: { type: String, enum: ["wedsy", "owner"], default: "wedsy" },
  },
  { timestamps: true }
);

VenueSiteVisitSchema.index({ venue: 1, scheduledAt: 1 });
VenueSiteVisitSchema.index({ status: 1, scheduledAt: 1 });

module.exports =
  mongoose.models.VenueSiteVisit ||
  mongoose.model("VenueSiteVisit", VenueSiteVisitSchema);
