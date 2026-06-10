const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// Append-only internal event stream per lead (Wedsy OS Notion spec).
// Rows are written by the system when things happen to a lead and are NEVER
// edited or deleted — there are intentionally no update/delete routes.
// Spec types: call_logged | stage_changed | commented | lost_requested.
// (stage_changed / commented / lost_requested equivalents are currently recorded
// by the PR #25/#26 ActivityLog writes; cockpit endpoints write here directly.)
const LeadInternalEventSchema = new mongoose.Schema(
  {
    leadId: { type: ObjectId, ref: "Enquiry", required: true },
    type: { type: String, required: true },
    actorId: { type: ObjectId, ref: "Admin", default: null },
    payload: { type: Object, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
LeadInternalEventSchema.index({ leadId: 1, createdAt: -1 });

module.exports =
  mongoose.models.LeadInternalEvent ||
  mongoose.model("LeadInternalEvent", LeadInternalEventSchema);
