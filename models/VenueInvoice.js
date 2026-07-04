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
    kind: { type: String, enum: ["advance", "final", "addon"], default: "advance" },
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
    // D8 (additive): how GST was applied. Pre-existing invoices read as
    // "exclusive" — exactly the math they were created with.
    gstMode: { type: String, enum: ["exclusive", "inclusive", "none"], default: "exclusive" },
    discount: { type: Number, default: 0 },
    totals: {
      subtotal: { type: Number, default: 0 },
      taxable: { type: Number, default: 0 },
      gst: { type: Number, default: 0 },
      grandTotal: { type: Number, default: 0 },
    },
    // D8 (additive): T&C stamped from template/policyDoc + acceptance log.
    terms: [String],
    acceptance: {
      name: { type: String, default: "" },
      phone: { type: String, default: "" },
      at: { type: Date },
      channel: { type: String, enum: ["link", "whatsapp", ""], default: "" },
    },
    // Set when this invoice was converted from a bill (D8 bill-before-invoice).
    billRef: { type: mongoose.Schema.Types.ObjectId, ref: "VenueBill" },
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
        // D7 payments approval (all additive). Who recorded it, who physically
        // collected, optional proof upload. Pre-existing entries have no
        // status field and default to "approved" — exactly their old meaning.
        recordedByType: { type: String, enum: ["owner", "member", ""], default: "" },
        recordedById: { type: mongoose.Schema.Types.ObjectId },
        recordedByName: { type: String, default: "" },
        collectedBy: { type: String, default: "" },
        proofUrl: { type: String, default: "" },
        status: { type: String, enum: ["pending_approval", "approved", "rejected"], default: "approved" },
        // Permanent "Owner entry" label (D7: owner-recorded auto-approves).
        ownerEntry: { type: Boolean, default: false },
        approvedByName: { type: String, default: "" },
        approvedAt: { type: Date },
        rejectedReason: { type: String, default: "" },
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
