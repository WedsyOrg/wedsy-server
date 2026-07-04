const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// MB8b Slice 2 — per-lead STEP INSTANCES, stamped from StepDefinition when a
// lead enters the journey (at qualification). Owners come from the MB8a roster
// (multi-owner allowed). Status is EXACTLY one of four. Optional steps can be
// marked not-applicable. Dependencies (opt-in) block a step from STARTING until
// the named steps are complete (cycle-validated, soft guard).
const STATUSES = ["not_started", "in_progress", "awaiting_client", "complete"];

// A note on the step's own contextual thread. Each note ALSO mirrors into the
// one lead chat (LeadChatMessage) — see LeadStepService.addNote.
const StepNoteSchema = new mongoose.Schema(
  {
    authorId: { type: ObjectId, ref: "Admin", default: null },
    body: { type: String, default: "" },
    mentions: { type: [ObjectId], ref: "Admin", default: [] },
    // The mirrored chat message id, so the step note links to its chat echo.
    chatMessageId: { type: ObjectId, ref: "LeadChatMessage", default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const LeadStepSchema = new mongoose.Schema(
  {
    leadId: { type: ObjectId, ref: "Enquiry", required: true, index: true },
    definitionId: { type: ObjectId, ref: "StepDefinition", default: null },
    name: { type: String, required: true },
    phase: { type: String, default: "" },
    order: { type: Number, default: 0 },
    // Owners assigned from the lead's current team roster (MB8a). Multi-owner.
    ownerIds: { type: [{ type: ObjectId, ref: "Admin" }], default: [] },
    status: { type: String, enum: STATUSES, default: "not_started" },
    dueAt: { type: Date, default: null },
    rolling: { type: Boolean, default: false },
    optional: { type: Boolean, default: false },
    // Optional steps skipped on this lead. Distinct from the 4 statuses.
    notApplicable: { type: Boolean, default: false },
    // Other LeadStep ids that must be complete before this one can start.
    dependsOn: { type: [{ type: ObjectId, ref: "LeadStep" }], default: [] },
    notes: { type: [StepNoteSchema], default: [] },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

LeadStepSchema.index({ leadId: 1, order: 1 });
// MB8c-1 — the My Work dashboard reads steps by owner + status; pipeline reads
// by leadId. These keep the cross-lead aggregations indexed.
LeadStepSchema.index({ ownerIds: 1, status: 1 });
LeadStepSchema.index({ dueAt: 1 });

module.exports = mongoose.models.LeadStep || mongoose.model("LeadStep", LeadStepSchema);
module.exports.STATUSES = STATUSES;
