const mongoose = require("mongoose");

// Phase 3 (3.1) — a confirmed booking, created (as a draft) when a lead moves to
// "booked". One booking per enquiry (idempotent via the unique sparse index).
const VenueBookingSchema = new mongoose.Schema(
  {
    venue: { type: mongoose.Schema.Types.ObjectId, ref: "Venue", required: true },
    enquiry: { type: mongoose.Schema.Types.ObjectId, ref: "VenueEnquiry" },
    coupleName: { type: String, default: "" },
    couplePhone: { type: String, default: "" },
    days: [
      {
        date: { type: Date },
        eventType: { type: String, default: "" },
        guestCount: { type: Number, default: 0 },
        spaces: [{ type: String }],
      },
    ],
    totalValue: { type: Number, default: 0 },
    // Booking-engine S2/S4 EXTEND this rather than introducing a second model.
    // It already held {label, dueDate, amount}; what was missing is the shape the
    // money came from and whether it has arrived.
    paymentSchedule: [
      {
        label: { type: String, default: "" },
        dueDate: { type: Date },
        amount: { type: Number, default: 0 },
        // S2: the percentage this row represents of the booking value. Stored
        // alongside the amount, not instead of it, because the amount is what
        // the couple owes and must not silently move if the booking value is
        // later corrected — while the percentage is what the owner reasoned in
        // and what the confirmation document shows. Rows written before this
        // slice have no percent, which reads correctly as "amount only".
        percent: { type: Number, min: 0, max: 100, default: null },
        // S4: payment against this milestone. `paid` is DERIVED on read from
        // paidAmount vs amount rather than stored, so the two cannot drift.
        paidAmount: { type: Number, default: 0, min: 0 },
        paidAt: { type: Date },
        // "other" carries its own name in paidModeOther. Without it, a method
        // outside this list had nowhere to go: the confirm path silently
        // mapped anything unrecognised to "" and the owner's answer was lost.
        paidMode: { type: String, enum: ["bank_transfer", "cash", "cheque", "upi", "card", "other", ""], default: "" },
        /** What the owner called it when they picked "Other". */
        paidModeOther: { type: String, default: "" },
        paidReference: { type: String, default: "" },
        /** Free note against this payment — "paid by the bride's father", etc. */
        paidNote: { type: String, default: "" },
        recordedBy: { type: mongoose.Schema.Types.ObjectId },
        recordedByName: { type: String, default: "" },
      },
    ],
    specialRequirements: { type: String, default: "" },
    // Booking→Rooms handoff (product-map dead-end #6, "the Rooms island"): the
    // lead says "we need 20 rooms" and Rooms/PMS never hears about it. Carried
    // onto the booking at creation so the accommodation requirement survives
    // the lead→booking graduation and the PMS can show a real shortfall
    // instead of the owner re-reading the enquiry. Snapshot, not a live join:
    // the reads cross-check the lead so a later change to the requirement is
    // still reflected.
    roomsRequired: { type: Number, default: 0 },
    // MB-CRM-2 S2 (additive): the agreement chosen in the Confirm Booking
    // wizard — a document-engine doc id (generated from template or an
    // attached signed scan). Loose ObjectId on purpose: the docs engine has
    // several doc models and the wizard only needs the pointer.
    agreementDoc: { type: mongoose.Schema.Types.ObjectId },
    status: {
      type: String,
      enum: ["confirmed", "in_progress", "completed", "cancelled"],
      default: "confirmed",
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "VenueOwner" },
    // D6 (additive): archived per-wedding room blocks — the immutable summary
    // of each completed stay. Rooms themselves live on in Venue.rooms.
    roomsHistory: [
      {
        allotment: { type: mongoose.Schema.Types.ObjectId, ref: "VenueRoomAllotment" },
        roomName: { type: String, default: "" },
        guestName: { type: String, default: "" },
        checkInAt: { type: Date },
        checkOutAt: { type: Date },
        guestCount: { type: Number, default: 0 },
        extraBeds: { type: Number, default: 0 },
        damagesTotal: { type: Number, default: 0 },
        deducted: { type: Number, default: 0 },
        refundDue: { type: Number, default: 0 },
        archivedAt: { type: Date },
      },
    ],
  },
  { timestamps: true }
);

VenueBookingSchema.index({ venue: 1, createdAt: -1 });
// One booking per enquiry (sparse: bookings without an enquiry are allowed).
VenueBookingSchema.index({ enquiry: 1 }, { unique: true, sparse: true });

module.exports = mongoose.models.VenueBooking || mongoose.model("VenueBooking", VenueBookingSchema);
