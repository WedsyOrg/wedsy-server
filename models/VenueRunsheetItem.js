const mongoose = require("mongoose");

// Phase 5 (PMS) — one line on a booking day's event-day runsheet.
// `owner` is free text or a team member's name; `vendorPhone` (optional)
// powers a wa.me link for category=vendor lines.
const VenueRunsheetItemSchema = new mongoose.Schema(
  {
    venue: { type: mongoose.Schema.Types.ObjectId, ref: "Venue", required: true },
    booking: { type: mongoose.Schema.Types.ObjectId, ref: "VenueBooking", required: true },
    day: { type: Date, required: true }, // midnight UTC of the booking day
    time: { type: String, default: "" }, // "HH:MM" display time
    title: { type: String, required: true },
    owner: { type: String, default: "" },
    vendorPhone: { type: String, default: "" },
    category: {
      type: String,
      enum: ["setup", "ceremony", "catering", "vendor", "teardown", "other"],
      default: "other",
    },
    status: {
      type: String,
      enum: ["pending", "in_progress", "done"],
      default: "pending",
    },
    order: { type: Number, default: 0 },
    notes: { type: String, default: "" },
    // true for the auto-seeded skeleton rows (still editable/deletable).
    seeded: { type: Boolean, default: false },
  },
  { timestamps: true }
);

VenueRunsheetItemSchema.index({ venue: 1, booking: 1, day: 1, order: 1 });

module.exports =
  mongoose.models.VenueRunsheetItem || mongoose.model("VenueRunsheetItem", VenueRunsheetItemSchema);
