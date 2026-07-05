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
    // ── D6 per-wedding room workflow (all additive) ──
    // Check-in capture (tablet flow): guest inventory + e-sign + ID photos,
    // all uploads via the existing /file/upload S3 path (URLs only here).
    checkIn: {
      guestCount: { type: Number, default: 0 },
      extraBeds: { type: Number, default: 0 },
      inventory: [{ item: { type: String, default: "" }, qty: { type: Number, default: 1 } }],
      idCaptureUrl: { type: String, default: "" },
      photoUrl: { type: String, default: "" },
      signatureUrl: { type: String, default: "" },
      notes: { type: String, default: "" },
      byName: { type: String, default: "" },
      at: { type: Date },
    },
    // Refundable security deposit held for the stay.
    deposit: { amount: { type: Number, default: 0 } },
    // Check-out checklist + damages + the computed deposit settlement.
    checkOut: {
      checklist: [{ item: { type: String, default: "" }, ok: { type: Boolean, default: true } }],
      damages: [{ desc: { type: String, default: "" }, charge: { type: Number, default: 0 } }],
      notes: { type: String, default: "" },
      byName: { type: String, default: "" },
      at: { type: Date },
    },
    settlement: {
      deposit: { type: Number, default: 0 },
      damagesTotal: { type: Number, default: 0 },
      deducted: { type: Number, default: 0 }, // kept by the venue (≤ deposit)
      refundDue: { type: Number, default: 0 }, // returned to the guest
      payableDue: { type: Number, default: 0 }, // damages beyond the deposit
      invoiceRef: { type: mongoose.Schema.Types.ObjectId, ref: "VenueInvoice" },
      settledAt: { type: Date },
    },
    // Completed block archived onto the booking history — rooms live on.
    archived: { type: Boolean, default: false },
    archivedAt: { type: Date },
  },
  { timestamps: true }
);

VenueRoomAllotmentSchema.index({ venue: 1, booking: 1 });
VenueRoomAllotmentSchema.index({ venue: 1, room: 1, checkInAt: 1 });

module.exports =
  mongoose.models.VenueRoomAllotment || mongoose.model("VenueRoomAllotment", VenueRoomAllotmentSchema);
