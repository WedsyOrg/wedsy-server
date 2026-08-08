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
    paymentSchedule: [
      {
        label: { type: String, default: "" },
        dueDate: { type: Date },
        amount: { type: Number, default: 0 },
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
