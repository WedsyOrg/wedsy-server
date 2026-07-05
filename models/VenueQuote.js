const mongoose = require("mongoose");

// Phase 3 (3.2) — a versioned quote for an enquiry. A new version supersedes the
// prior one (version auto-increments per enquiry).
const VenueQuoteSchema = new mongoose.Schema(
  {
    venue: { type: mongoose.Schema.Types.ObjectId, ref: "Venue", required: true },
    enquiry: { type: mongoose.Schema.Types.ObjectId, ref: "VenueEnquiry", required: true },
    version: { type: Number, default: 1 },
    lineItems: [
      {
        label: { type: String, default: "" },
        category: {
          type: String,
          enum: ["venue_hire", "catering", "decoration", "accommodation", "other"],
          default: "other",
        },
        qty: { type: Number, default: 1 },
        unitPrice: { type: Number, default: 0 },
        perDay: { type: Boolean, default: false },
        day: { type: Number, default: null },
      },
    ],
    gstPercent: { type: Number, default: 18 },
    // D8 (additive): GST mode; pre-existing quotes read as "exclusive".
    gstMode: { type: String, enum: ["exclusive", "inclusive", "none"], default: "exclusive" },
    // E3x white-label: true → PDF renders venue-branding-only (small
    // "Powered by Wedsy" footer, no system line). Defaults per venue setting.
    whiteLabel: { type: Boolean, default: false },
    discount: { type: Number, default: 0 },
    totals: {
      subtotal: { type: Number, default: 0 },
      taxable: { type: Number, default: 0 },
      gst: { type: Number, default: 0 },
      grandTotal: { type: Number, default: 0 },
    },
    // D8 (additive): T&C block + acceptance log.
    terms: [String],
    acceptance: {
      name: { type: String, default: "" },
      phone: { type: String, default: "" },
      at: { type: Date },
      channel: { type: String, enum: ["link", "whatsapp", ""], default: "" },
    },
    status: {
      type: String,
      enum: ["draft", "sent", "accepted", "superseded"],
      default: "draft",
    },
  },
  { timestamps: true }
);

VenueQuoteSchema.index({ venue: 1, createdAt: -1 });
VenueQuoteSchema.index({ enquiry: 1, version: -1 });

module.exports = mongoose.models.VenueQuote || mongoose.model("VenueQuote", VenueQuoteSchema);
