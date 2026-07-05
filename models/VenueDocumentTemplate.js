const mongoose = require("mongoose");
const { GST_MODES } = require("../utils/venueMoney");

// D8 document engine: an owner-authored preset for generating quotes, bills,
// invoices, contracts or custom docs. Line-item presets seed money docs;
// sections seed contract-style clause docs; terms is the reusable T&C block
// stamped onto documents (falls back to Venue.policyDoc when absent).
const VenueDocumentTemplateSchema = new mongoose.Schema(
  {
    venue: { type: mongoose.Schema.Types.ObjectId, ref: "Venue", required: true },
    type: { type: String, enum: ["quote", "bill", "invoice", "contract", "custom"], required: true },
    name: { type: String, required: true, trim: true },
    lineItems: [
      {
        label: { type: String, default: "" },
        category: { type: String, default: "other" },
        qty: { type: Number, default: 1 },
        unitPrice: { type: Number, default: 0 },
        perDay: { type: Boolean, default: false },
      },
    ],
    sections: [
      {
        heading: { type: String, default: "" },
        clauses: [String],
      },
    ],
    terms: [String],
    gstMode: { type: String, enum: GST_MODES, default: "exclusive" },
    gstPercent: { type: Number, default: 18, min: 0, max: 100 },
  },
  { timestamps: true }
);

VenueDocumentTemplateSchema.index({ venue: 1, type: 1, name: 1 }, { unique: true });

module.exports =
  mongoose.models.VenueDocumentTemplate || mongoose.model("VenueDocumentTemplate", VenueDocumentTemplateSchema);
