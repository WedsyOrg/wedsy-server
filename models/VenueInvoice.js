const mongoose = require("mongoose");

// Phase 3 (3.3) — a GST invoice generated from a booking. invoiceNumber is a
// per-venue auto-incrementing string (prefix + zero-padded seq) assigned at
// creation and immutable thereafter.
const VenueInvoiceSchema = new mongoose.Schema(
  {
    venue: { type: mongoose.Schema.Types.ObjectId, ref: "Venue", required: true },
    booking: { type: mongoose.Schema.Types.ObjectId, ref: "VenueBooking", required: true },
    invoiceNumber: { type: String, required: true },
    seq: { type: Number, required: true }, // per-venue sequence backing invoiceNumber
    kind: { type: String, enum: ["advance", "final"], default: "advance" },
    lineItems: [
      {
        label: { type: String, default: "" },
        category: { type: String, default: "other" },
        qty: { type: Number, default: 1 },
        unitPrice: { type: Number, default: 0 },
        perDay: { type: Boolean, default: false },
        day: { type: Number, default: null },
      },
    ],
    gstPercent: { type: Number, default: 18 },
    discount: { type: Number, default: 0 },
    totals: {
      subtotal: { type: Number, default: 0 },
      gst: { type: Number, default: 0 },
      grandTotal: { type: Number, default: 0 },
    },
    status: {
      type: String,
      enum: ["unpaid", "partially_paid", "paid"],
      default: "unpaid",
    },
    payments: [
      {
        date: { type: Date, default: Date.now },
        amount: { type: Number, default: 0 },
        mode: { type: String, enum: ["bank_transfer", "cash", "cheque", "upi", "card"], default: "bank_transfer" },
        note: { type: String, default: "" },
      },
    ],
  },
  { timestamps: true }
);

VenueInvoiceSchema.index({ venue: 1, createdAt: -1 });
VenueInvoiceSchema.index({ booking: 1 });
// Unique invoice number per venue.
VenueInvoiceSchema.index({ venue: 1, invoiceNumber: 1 }, { unique: true });

module.exports = mongoose.models.VenueInvoice || mongoose.model("VenueInvoice", VenueInvoiceSchema);
