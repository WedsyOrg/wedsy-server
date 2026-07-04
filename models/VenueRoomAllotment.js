const mongoose = require("mongoose");

// Phase 5 (PMS) — a room allotted to a booking's guest for a date range.
// Conflict prevention is enforced atomically through VenueRoomNight's unique
// (room, night) index — see controllers/venueAllotment.js; this doc is the
// human-facing record.
const VenueRoomAllotmentSchema = new mongoose.Schema(
  {
    venue: { type: mongoose.Schema.Types.ObjectId, ref: "Venue", required: true },
    booking: { type: mongoose.Schema.Types.ObjectId, ref: "VenueBooking", required: true },
    // Subdocument id inside Venue.rooms (not a top-level collection ref).
    room: { type: mongoose.Schema.Types.ObjectId, required: true },
    guestName: { type: String, default: "" },
    guestPhone: { type: String, default: "" },
    checkInAt: { type: Date, required: true },
    checkOutAt: { type: Date, required: true },
    actualCheckInAt: { type: Date },
    actualCheckOutAt: { type: Date },
    status: {
      type: String,
      enum: ["allotted", "checked_in", "checked_out", "cancelled"],
      default: "allotted",
    },
    notes: { type: String, default: "" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "VenueOwner" },
  },
  { timestamps: true }
);

VenueRoomAllotmentSchema.index({ venue: 1, booking: 1 });
VenueRoomAllotmentSchema.index({ venue: 1, room: 1, checkInAt: 1 });

module.exports =
  mongoose.models.VenueRoomAllotment || mongoose.model("VenueRoomAllotment", VenueRoomAllotmentSchema);
