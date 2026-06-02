const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;
const ActivityLogSchema = new mongoose.Schema(
  {
    actorId: { type: ObjectId, ref: "Admin", default: null },  // who did it (admin)
    action: { type: String, required: true },   // e.g. "stage.created", "stage.renamed", "stage.reordered", "stage.deleted"
    entityType: { type: String, default: "stage" }, // "stage" for now; extensible later ("lead", "project")
    entityId: { type: String, default: null },   // id/slug of the affected entity
    summary: { type: String, default: "" },       // human-readable one-liner
    meta: { type: Object, default: {} },          // structured extras (e.g. { from, to, movedLeads })
  },
  { timestamps: true }
);
ActivityLogSchema.index({ createdAt: -1 });
ActivityLogSchema.index({ entityType: 1, createdAt: -1 });
module.exports = mongoose.models.ActivityLog || mongoose.model("ActivityLog", ActivityLogSchema);
