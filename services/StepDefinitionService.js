const mongoose = require("mongoose");
const StepDefinitionRepository = require("../repositories/StepDefinitionRepository");
const { PHASES } = require("../models/StepDefinition");

const err = (status, message) => Object.assign(new Error(message), { status });
const isId = (v) => mongoose.Types.ObjectId.isValid(v);

// Wedsy's real step-set (from their Zoho Projects / Bigin), grouped into 3
// phases. systemKey makes the seed idempotent AND edit-preserving: a re-run
// inserts only the keys that are missing, never clobbering admin changes. The
// two "Client Follow Up" rows live in different phases → distinct keys.
const SEED_SET = [
  // Phase 1 — Lead Understanding
  { systemKey: "lu-review-bigin-notes", phase: PHASES[0], name: "Review Bigin Notes" },
  { systemKey: "lu-internal-team-discussion", phase: PHASES[0], name: "Internal Team Discussion" },
  { systemKey: "lu-responsibility-allocation", phase: PHASES[0], name: "Responsibility Allocation" },
  { systemKey: "lu-gmeet-mom-team", phase: PHASES[0], name: "Google Meet MOM - Team Discussion" },
  { systemKey: "lu-gmeet-mom-client-wa", phase: PHASES[0], name: "Google Meet MOM to client WhatsApp" },
  // Phase 2 — Client Servicing & Proposal
  { systemKey: "csp-client-follow-up", phase: PHASES[1], name: "Client Follow Up", rolling: true },
  { systemKey: "csp-venue-assistance", phase: PHASES[1], name: "Venue Assistance", rolling: true, optional: true },
  { systemKey: "csp-venue-proposal", phase: PHASES[1], name: "Venue Proposal", optional: true },
  { systemKey: "csp-client-engagement-content", phase: PHASES[1], name: "Client Engagement Content", rolling: true },
  { systemKey: "csp-decor-concept-discussion", phase: PHASES[1], name: "Decor Concept Discussion", rolling: true },
  { systemKey: "csp-vendor-suggestions", phase: PHASES[1], name: "Vendor Suggestions", rolling: true, optional: true },
  { systemKey: "csp-proposal-preparation", phase: PHASES[1], name: "Proposal Preparation" },
  { systemKey: "csp-proposal-shared", phase: PHASES[1], name: "Proposal Shared" },
  // Phase 3 — Follow Up & Conversion
  { systemKey: "fuc-client-follow-up", phase: PHASES[2], name: "Client Follow Up", rolling: true },
  { systemKey: "fuc-capture-feedback-team", phase: PHASES[2], name: "Capture Client Feedback & Team Discussion" },
  { systemKey: "fuc-negotiation-call", phase: PHASES[2], name: "Negotiation Call with Client" },
  { systemKey: "fuc-send-booking-form", phase: PHASES[2], name: "Send Booking Form (T&Cs)" },
  { systemKey: "fuc-collect-onboarding-fee", phase: PHASES[2], name: "Collect Onboarding Fee" },
];

// Idempotent seed: insert any SEED_SET key not already present. Order is the
// SEED_SET index (×10, leaving gaps for inserts). Returns counts.
const seed = async () => {
  let created = 0;
  for (let i = 0; i < SEED_SET.length; i++) {
    const def = SEED_SET[i];
    const existing = await StepDefinitionRepository.findBySystemKey(def.systemKey);
    if (existing) continue;
    await StepDefinitionRepository.create({
      name: def.name,
      phase: def.phase,
      order: (i + 1) * 10,
      rolling: !!def.rolling,
      optional: !!def.optional,
      status: "active",
      systemKey: def.systemKey,
    });
    created += 1;
  }
  return { created, total: SEED_SET.length };
};

const list = async ({ includeArchived = false } = {}) =>
  includeArchived ? StepDefinitionRepository.findAll() : StepDefinitionRepository.findActive();

const PHASE_SET = new Set(PHASES);

const create = async ({ name, phase, defaultDepartment, rolling, optional } = {}) => {
  if (!name || !String(name).trim()) throw err(400, "name is required");
  if (!phase || !PHASE_SET.has(phase)) throw err(400, `phase must be one of: ${PHASES.join(", ")}`);
  const order = (await StepDefinitionRepository.maxOrder()) + 10;
  return StepDefinitionRepository.create({
    name: String(name).trim(),
    phase,
    order,
    defaultDepartment: defaultDepartment || "",
    rolling: !!rolling,
    optional: !!optional,
    status: "active",
  });
};

// Rename / toggle rolling+optional / re-phase / change default department.
const update = async (id, fields = {}) => {
  if (!isId(id)) throw err(400, "Invalid id");
  const allowed = {};
  if (fields.name !== undefined) {
    if (!String(fields.name).trim()) throw err(400, "name cannot be empty");
    allowed.name = String(fields.name).trim();
  }
  if (fields.phase !== undefined) {
    if (!PHASE_SET.has(fields.phase)) throw err(400, `phase must be one of: ${PHASES.join(", ")}`);
    allowed.phase = fields.phase;
  }
  if (fields.rolling !== undefined) allowed.rolling = !!fields.rolling;
  if (fields.optional !== undefined) allowed.optional = !!fields.optional;
  if (fields.defaultDepartment !== undefined) allowed.defaultDepartment = String(fields.defaultDepartment || "");
  const updated = await StepDefinitionRepository.updateById(id, allowed);
  if (!updated) throw err(404, "Step definition not found");
  return updated;
};

// Soft delete — archive (instantiated LeadSteps keep their reference).
const archive = async (id) => {
  if (!isId(id)) throw err(400, "Invalid id");
  const updated = await StepDefinitionRepository.updateById(id, { status: "archived" });
  if (!updated) throw err(404, "Step definition not found");
  return updated;
};

// Reorder: { orderedIds: [id, ...] } → assigns order 10,20,30…
const reorder = async (orderedIds) => {
  if (!Array.isArray(orderedIds) || !orderedIds.length) throw err(400, "orderedIds must be a non-empty array");
  for (const id of orderedIds) if (!isId(id)) throw err(400, `Invalid id in orderedIds: ${id}`);
  let order = 10;
  for (const id of orderedIds) {
    await StepDefinitionRepository.updateById(id, { order });
    order += 10;
  }
  return list();
};

module.exports = { SEED_SET, PHASES, seed, list, create, update, archive, reorder };
