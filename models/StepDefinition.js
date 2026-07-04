const mongoose = require("mongoose");

// MB8b Slice 1 — the configurable journey STEP DEFINITIONS (Settings). An
// ordered, phase-grouped template set; instances (LeadStep) are stamped per
// lead from these. Founder / CRM-Admin editable (settings:edit:all). Mirrors the
// CustomFieldDef pattern: defs are ARCHIVED, never hard-deleted, so already
// instantiated LeadSteps keep a stable reference.
const PHASES = [
  "Lead Understanding",
  "Client Servicing & Proposal",
  "Follow Up & Conversion",
];

const StepDefinitionSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phase: { type: String, required: true },
    order: { type: Number, default: 0 }, // global order across all phases
    // Optional default serving department (a hint for owner assignment).
    defaultDepartment: { type: String, default: "" },
    // rolling = recurs throughout the journey (e.g. Client Follow Up); optional =
    // may be skipped / marked not-applicable on a lead.
    rolling: { type: Boolean, default: false },
    optional: { type: Boolean, default: false },
    status: { type: String, enum: ["active", "archived"], default: "active" },
    // Stable key for idempotent seeding (seed never clobbers admin edits).
    systemKey: { type: String, default: "" },
  },
  { timestamps: true }
);

StepDefinitionSchema.index({ status: 1, order: 1 });

module.exports = mongoose.models.StepDefinition || mongoose.model("StepDefinition", StepDefinitionSchema);
module.exports.PHASES = PHASES;
