const mongoose = require("mongoose");

// Phase 5 (PMS) — one doc per (room, occupied night). The UNIQUE compound
// index is the atomic double-booking guard: concurrent allotments for an
// overlapping range race on insertMany here, and exactly one can win — no
// transactions needed on a standalone local Mongo.
const VenueRoomNightSchema = new mongoose.Schema(
  {
    venue: { type: mongoose.Schema.Types.ObjectId, ref: "Venue", required: true },
    room: { type: mongoose.Schema.Types.ObjectId, required: true },
    // Midnight UTC of the occupied night.
    night: { type: Date, required: true },
    allotment: { type: mongoose.Schema.Types.ObjectId, ref: "VenueRoomAllotment", required: true },
  },
  { timestamps: true }
);

VenueRoomNightSchema.index({ room: 1, night: 1 }, { unique: true });
VenueRoomNightSchema.index({ allotment: 1 });

module.exports = mongoose.models.VenueRoomNight || mongoose.model("VenueRoomNight", VenueRoomNightSchema);
