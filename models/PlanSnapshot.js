const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// P2 — THE PUBLISH MEMBRANE. Everything the couple ever sees is a SNAPSHOT
// frozen at publish time (composed server-side into `content`) — the working
// plan/drafts keep moving underneath without rewriting what was shown.
const PlanSnapshotSchema = new mongoose.Schema(
  {
    leadId: { type: ObjectId, ref: "Enquiry", required: true, index: true },
    kind: { type: String, enum: ["reveal", "options", "draft", "comparison"], required: true },
    title: { type: String, default: "" },
    coverNote: { type: String, default: "" },
    pricingVisible: { type: Boolean, default: false },
    forDecision: { type: Boolean, default: false },
    // The FROZEN render payload — the FE renders this verbatim, nothing live.
    content: { type: Object, default: {} },
    publishedBy: { type: ObjectId, ref: "Admin", default: null },
    at: { type: Date, default: Date.now },
  },
  { timestamps: true }
);
PlanSnapshotSchema.index({ leadId: 1, at: -1 });

module.exports = mongoose.models.PlanSnapshot || mongoose.model("PlanSnapshot", PlanSnapshotSchema);
