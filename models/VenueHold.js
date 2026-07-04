const mongoose = require("mongoose");

// D3 holds: a request to reserve date(s) — owner-approved, never auto-granted.
// Wedsy-side (admin token) creates land as "requested"; the owner approves or
// declines (owner may also raise their own, which still go through approve so
// the SpaceDate write path is single). Approval writes the held VenueSpaceDate
// rows atomically; decline/expiry/release free them; convert flips held→booked.
const VenueHoldSchema = new mongoose.Schema(
  {
    venue: { type: mongoose.Schema.Types.ObjectId, ref: "Venue", required: true },
    // Venue.spaces subdoc _id. Absent = venue-wide (claims every bookable space).
    space: { type: mongoose.Schema.Types.ObjectId },
    // UTC-midnight calendar dates the hold covers (1..N).
    dates: { type: [Date], required: true },
    requestedBy: { type: String, enum: ["wedsy", "owner"], required: true },
    // Who asked (display name for the calendar chip) + optional lead linkage.
    requestedByName: { type: String, default: "" },
    linkedEnquiry: { type: mongoose.Schema.Types.ObjectId, ref: "VenueEnquiry" },
    status: {
      type: String,
      enum: ["requested", "approved", "declined", "expired", "converted", "released"],
      default: "requested",
    },
    expiresAt: { type: Date, required: true },
    notes: { type: String, default: "" },
    decidedAt: { type: Date },
    decidedBy: { type: String, default: "" }, // actor display name
  },
  { timestamps: true }
);

VenueHoldSchema.index({ venue: 1, status: 1 });
VenueHoldSchema.index({ status: 1, expiresAt: 1 }); // expiry sweep
VenueHoldSchema.index({ linkedEnquiry: 1 });

module.exports = mongoose.models.VenueHold || mongoose.model("VenueHold", VenueHoldSchema);
