const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// MB-V2 P0 S4 — D1's explicit venue→Sales-CRM bridge, VENUE-OWNED.
// Wedsy admins forward a venue lead to the Sales CRM by creating one of these;
// the CRM receive side (OS's build, per the agreed sequencing) consumes
// status:"pending_os" rows and flips them to accepted/rejected. Nothing here
// touches CRM models. enquiryRef is unique — forwarding is idempotent by
// construction (one bridge row per venue lead, ever).
const VenueForwardRequestSchema = new mongoose.Schema(
  {
    venue: { type: ObjectId, ref: "Venue", required: true },
    enquiryRef: { type: ObjectId, ref: "VenueEnquiry", required: true, unique: true },
    // Denormalized snapshots so the OS consumer doesn't need venue-engine reads.
    coupleName: { type: String, default: "" },
    couplePhone: { type: String, default: "" },
    notes: { type: String, default: "", maxlength: 2000 },
    forwardedBy: { type: ObjectId, ref: "Admin" },
    forwardedByName: { type: String, default: "" },
    status: {
      type: String,
      enum: ["pending_os", "accepted", "rejected"],
      default: "pending_os",
    },
  },
  { timestamps: true }
);

VenueForwardRequestSchema.index({ status: 1, createdAt: -1 });
VenueForwardRequestSchema.index({ venue: 1, createdAt: -1 });

module.exports =
  mongoose.models.VenueForwardRequest ||
  mongoose.model("VenueForwardRequest", VenueForwardRequestSchema);
