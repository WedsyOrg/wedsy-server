const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// A converted lead — the "won" handoff from Sales to Client Servicing.
// Created exclusively via POST /enquiry/:_id/convert (Lead Lifecycle, Slice D).
const ProjectSchema = new mongoose.Schema(
  {
    leadId: { type: ObjectId, ref: "Enquiry", required: true },
    coupleNames: { type: String, default: "" },
    eventIds: { type: [ObjectId], ref: "Event", default: [] },
    csOwnerId: { type: ObjectId, ref: "Admin", default: null },
    convertedBy: { type: ObjectId, ref: "Admin", default: null },
    value: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["active", "completed", "on_hold"],
      default: "active",
    },
    handoffNote: { type: String, default: "" },
  },
  { timestamps: true }
);
ProjectSchema.index({ csOwnerId: 1, createdAt: -1 });
ProjectSchema.index({ leadId: 1 });

module.exports = mongoose.models.Project || mongoose.model("Project", ProjectSchema);
