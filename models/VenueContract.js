const mongoose = require("mongoose");

// Phase 3.5 — a booking contract: ordered clause sections seeded from the
// venue's policyDoc plus structured booking specifics. "Acknowledged" is a
// DIGITAL ACKNOWLEDGMENT (name + phone match against the booking), not a
// legal e-signature — the UI labels it accordingly.
const VenueContractSchema = new mongoose.Schema(
  {
    venue: { type: mongoose.Schema.Types.ObjectId, ref: "Venue", required: true },
    booking: { type: mongoose.Schema.Types.ObjectId, ref: "VenueBooking", required: true },
    version: { type: Number, default: 1 },
    // Ordered clause sections (heading + numbered clause strings).
    sections: [
      {
        heading: { type: String, default: "" },
        clauses: [{ type: String }],
      },
    ],
    // Frozen booking facts at generation time (edits to the booking later do
    // not silently rewrite a sent contract).
    parties: {
      venueName: { type: String, default: "" },
      coupleName: { type: String, default: "" },
      couplePhone: { type: String, default: "" },
    },
    specifics: {
      days: [
        {
          date: { type: Date },
          eventType: { type: String, default: "" },
          guestCount: { type: Number, default: 0 },
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
    },
    status: {
      type: String,
      enum: ["draft", "sent", "acknowledged", "void"],
      default: "draft",
    },
    sentAt: { type: Date },
    acknowledgedAt: { type: Date },
    acknowledgmentName: { type: String, default: "" },
    acknowledgmentPhone: { type: String, default: "" },
  },
  { timestamps: true }
);

VenueContractSchema.index({ venue: 1, booking: 1, version: -1 });

module.exports = mongoose.models.VenueContract || mongoose.model("VenueContract", VenueContractSchema);
