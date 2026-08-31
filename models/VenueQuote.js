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
        // ── MONEY LINES (Phase 1, additive) ─────────────────────────────────
        // A LINE-MODE row carries its own money facts; legacy rows have
        // amount null and gstTreatment "" and keep meaning qty × unitPrice.
        // The controller keeps qty/unitPrice mirrored (qty 1, unitPrice =
        // amount) on line-mode rows so every renderer and the invoice
        // precedence that read qty × unitPrice stay correct unmodified.
        /** The line's amount in whole rupees. null = legacy row. */
        amount: { type: Number, default: null },
        /**
         * GST TREATMENT against the quote's single gstPercent — never a
         * per-line rate: none = no GST · full = on the amount · part = on
         * taxableAmount. "" = legacy row (document-mode math applies).
         */
        gstTreatment: { type: String, enum: ["", "none", "full", "part"], default: "" },
        /** Only under "part"; strictly less than amount. */
        taxableAmount: { type: Number, default: 0 },
        /**
         * Held and returned. Inside the document total, NEVER revenue: the
         * seam excludes refundable lines from VenueBooking.totalValue. A
         * non-refundable "deposit" is an ordinary line and does not set this.
         */
        refundable: { type: Boolean, default: false },
        /**
         * Which standing charge this line was picked from — a breadcrumb,
         * never a join. The line COPIED the charge's values at pick time and
         * stands alone; the charge may since be edited or deleted and this
         * line must not move. Nothing resolves this key.
         */
        source: {
          chargeKey: { type: String, default: "" },
        },
      },
    ],
    gstPercent: { type: Number, default: 18 },
    // D8 (additive): GST mode; pre-existing quotes read as "exclusive".
    // Line-mode quotes store "exclusive" (grandTotal = base + GST is that
    // shape) and the controller refuses any other value for them — GST comes
    // from each line's treatment, not from a document mode.
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
      // ── MONEY LINES (additive): the two figures the build exists for ──────
      // charged = Σ non-refundable line amounts, GST-exclusive — the revenue
      // figure the S3 seam writes into VenueBooking.totalValue. refundable =
      // Σ refundable line amounts — held and returned, inside grandTotal,
      // never revenue. Both 0 on legacy quotes.
      charged: { type: Number, default: 0 },
      refundable: { type: Number, default: 0 },
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
