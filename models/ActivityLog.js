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
// Who did what, for one actor — the query an investigation actually runs.
ActivityLogSchema.index({ actorId: 1, createdAt: -1 });

// ── RETENTION ───────────────────────────────────────────────────────────────
// 400 days: a full year plus a quarter, so an annual review can always look
// back over a complete preceding year without the window having closed behind
// it. An audit trail that grows forever is one nobody prunes and eventually
// someone drops wholesale; one that expires too soon is not an audit trail.
//
// THE NUMBER IS A PRODUCT DECISION and this is a starting position, not a
// ruling — if there is a statutory retention period for employment or payment
// records that touches these rows, it wins. Overridable via
// ACTIVITY_LOG_RETENTION_DAYS.
//
// NOTE: expireAfterSeconds is fixed when the index is created. Changing the
// value on a live deployment needs collMod (or a drop and rebuild); editing
// this line alone will not move an index that already exists.
const RETENTION_DAYS = Number(process.env.ACTIVITY_LOG_RETENTION_DAYS) || 400;
ActivityLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION_DAYS * 86400 });
module.exports = mongoose.models.ActivityLog || mongoose.model("ActivityLog", ActivityLogSchema);
