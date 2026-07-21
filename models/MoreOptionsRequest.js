const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// A3 — "SHOW MORE OPTIONS". The couple's per-category signal (fired from the
// couple app per event slot): "Sangeet · stage — couple wants more". No
// algorithm answers it — a human curates; a look added with
// provenance:"more_options" for the same slot auto-fulfils the open request.
const MoreOptionsRequestSchema = new mongoose.Schema(
  {
    leadId: { type: ObjectId, ref: "Enquiry", required: true, index: true },
    functionKey: { type: String, default: "" }, // haldi | sangeet | …
    categoryKey: { type: String, required: true }, // stage | nameboard | …
    requestedAt: { type: Date, default: Date.now },
    fulfilled: { type: Boolean, default: false, index: true },
    fulfilledAt: { type: Date, default: null },
    fulfilledBy: { type: ObjectId, ref: "Admin", default: null },
  },
  { timestamps: true }
);
MoreOptionsRequestSchema.index({ leadId: 1, fulfilled: 1, requestedAt: -1 });

module.exports =
  mongoose.models.MoreOptionsRequest || mongoose.model("MoreOptionsRequest", MoreOptionsRequestSchema);
