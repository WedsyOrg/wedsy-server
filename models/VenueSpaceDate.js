const mongoose = require("mongoose");

// D3 date-inventory: one row per (venue, space, date) that is NOT freely
// available — absence of a row means the space-date is open. The unique index
// is the atomic double-claim guard, the exact VenueRoomNight pattern: writers
// insertMany with ordered:true and treat E11000 as "somebody else holds it".
//
// state:
//   held    — an approved VenueHold claims it (holdRef set)
//   booked  — converted to a confirmed booking (bookingRef set)
//   blocked — owner manual block (notes optional)
const VenueSpaceDateSchema = new mongoose.Schema(
  {
    venue: { type: mongoose.Schema.Types.ObjectId, ref: "Venue", required: true },
    // Venue.spaces subdocument _id (spaces stay embedded on Venue — no fork).
    space: { type: mongoose.Schema.Types.ObjectId, required: true },
    // UTC midnight of the calendar date.
    date: { type: Date, required: true },
    state: { type: String, enum: ["held", "booked", "blocked"], required: true },
    holdRef: { type: mongoose.Schema.Types.ObjectId, ref: "VenueHold" },
    bookingRef: { type: mongoose.Schema.Types.ObjectId, ref: "VenueBooking" },
    // Groups the rows of one manual block write so a mid-insert unique-index
    // collision can atomically clean up exactly its own rows (blocks have no
    // holdRef to sweep by).
    batchRef: { type: mongoose.Schema.Types.ObjectId },
    notes: { type: String, default: "" },
  },
  { timestamps: true }
);

// The atomic guard: one claim per space per date.
VenueSpaceDateSchema.index({ venue: 1, space: 1, date: 1 }, { unique: true });
VenueSpaceDateSchema.index({ venue: 1, date: 1 });
VenueSpaceDateSchema.index({ holdRef: 1 });

module.exports = mongoose.models.VenueSpaceDate || mongoose.model("VenueSpaceDate", VenueSpaceDateSchema);
