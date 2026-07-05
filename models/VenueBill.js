const mongoose = require("mongoose");
const { GST_MODES } = require("../utils/venueMoney");

// D8 bill-before-invoice: the editable working money doc for a booking. A bill
// iterates freely (draft), goes to the couple for acceptance, and CONVERTS
// into the existing VenueInvoice (whose numbering machinery is untouched —
// conversion allocates a real invoice number at that moment, never before).
// isAddon marks post-booking supplementary bills (add-on billing).
const VenueBillSchema = new mongoose.Schema(
  {
    venue: { type: mongoose.Schema.Types.ObjectId, ref: "Venue", required: true },
    booking: { type: mongoose.Schema.Types.ObjectId, ref: "VenueBooking", required: true },
    // Light per-venue running number for reference ("BILL-7") — NOT the
    // statutory invoice number; that stays with VenueInvoice.
    billNumber: { type: String, default: "" },
    isAddon: { type: Boolean, default: false },
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
    gstMode: { type: String, enum: GST_MODES, default: "exclusive" },
    // E3x white-label: true → PDF renders venue-branding-only (small
    // "Powered by Wedsy" footer, no system line). Defaults per venue setting.
    whiteLabel: { type: Boolean, default: false },
    gstPercent: { type: Number, default: 18 },
    discount: { type: Number, default: 0 },
    totals: {
      subtotal: { type: Number, default: 0 },
      taxable: { type: Number, default: 0 },
      gst: { type: Number, default: 0 },
      grandTotal: { type: Number, default: 0 },
    },
    terms: [String],
    status: { type: String, enum: ["draft", "sent", "accepted", "converted", "void"], default: "draft" },
    invoiceRef: { type: mongoose.Schema.Types.ObjectId, ref: "VenueInvoice" },
    // D8 acceptance log — who said yes, when, over which channel.
    acceptance: {
      name: { type: String, default: "" },
      phone: { type: String, default: "" },
      at: { type: Date },
      channel: { type: String, enum: ["link", "whatsapp", ""], default: "" },
    },
    notes: { type: String, default: "" },
  },
  { timestamps: true }
);

VenueBillSchema.index({ venue: 1, createdAt: -1 });
VenueBillSchema.index({ booking: 1 });

module.exports = mongoose.models.VenueBill || mongoose.model("VenueBill", VenueBillSchema);
