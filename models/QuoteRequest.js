const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// L4 — QUOTE REQUEST: the couple sent their picks for pricing ("send for
// quote" in the app). Ingested via the internal seam; worked by the Store/CS
// teams from the workspace queue.
const QuoteRequestSchema = new mongoose.Schema(
  {
    leadId: { type: ObjectId, ref: "Enquiry", default: null, index: true },
    userId: { type: ObjectId, ref: "User", default: null, index: true },
    draftName: { type: String, default: "" },
    itemCount: { type: Number, default: 0 },
    payload: { type: Object, default: {} }, // the couple's picks, verbatim
    status: { type: String, enum: ["pending", "priced", "dismissed"], default: "pending", index: true },
    sentAt: { type: Date, default: Date.now },
    pricedBy: { type: ObjectId, ref: "Admin", default: null },
    pricedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
QuoteRequestSchema.index({ status: 1, sentAt: -1 });

module.exports = mongoose.models.QuoteRequest || mongoose.model("QuoteRequest", QuoteRequestSchema);
