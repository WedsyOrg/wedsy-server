const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// MB7b Slice 2 — a structured collaboration task tied to a lead.
//
// DECISION (legacy /task reuse): the legacy generic Task model
// (category/task/deadline/referenceId) is unreferenced by any service and lacks
// the lead/assignee/assigner/status semantics collaboration needs, so it is left
// untouched and a dedicated LeadTask is introduced instead of overloading it.
const LeadTaskSchema = new mongoose.Schema(
  {
    leadId: { type: ObjectId, ref: "Enquiry", required: true, index: true },
    title: { type: String, required: true },
    assigneeId: { type: ObjectId, ref: "Admin", required: true, index: true },
    assignerId: { type: ObjectId, ref: "Admin", required: true },
    dueAt: { type: Date, required: true },
    status: { type: String, enum: ["open", "done"], default: "open", index: true },
    // "task" = born-in-chat / standalone (Slice 2); "nurture" = the rolling CS
    // nurture touch (Slice 4), which carries ready-to-copy text.
    kind: { type: String, enum: ["task", "nurture"], default: "task" },
    nurtureText: { type: String, default: "" },
    createdInChatMessageId: { type: ObjectId, ref: "LeadChatMessage", default: null },
    completedAt: { type: Date, default: null },
    completedBy: { type: ObjectId, ref: "Admin", default: null },
    // Set once when the overdue escalation fires, so it never double-notifies.
    overdueEscalatedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

LeadTaskSchema.index({ assigneeId: 1, status: 1, dueAt: 1 });
LeadTaskSchema.index({ leadId: 1, kind: 1, status: 1 });

module.exports = mongoose.models.LeadTask || mongoose.model("LeadTask", LeadTaskSchema);
