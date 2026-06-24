const mongoose = require("mongoose");
const Admin = require("../models/Admin");
const Enquiry = require("../models/Enquiry");
const { STATUSES } = require("../models/LeadStep");
const LeadStepRepository = require("../repositories/LeadStepRepository");
const StepDefinitionRepository = require("../repositories/StepDefinitionRepository");
const LeadTeamMemberRepository = require("../repositories/LeadTeamMemberRepository");
const LeadInternalEventService = require("./LeadInternalEventService");
const LeadChatService = require("./LeadChatService");
const AdminNotificationService = require("./AdminNotificationService");

const err = (status, message) => Object.assign(new Error(message), { status });
const isId = (v) => mongoose.Types.ObjectId.isValid(v);

const STATUS_LABEL = {
  not_started: "Not started",
  in_progress: "In progress",
  awaiting_client: "Awaiting client",
  complete: "Complete",
};

// Instantiate the journey for a lead from the ACTIVE step definitions. Idempotent
// — a no-op if the lead already has steps (re-qualification won't duplicate).
const instantiateForLead = async (leadId, actorId) => {
  if (!isId(leadId)) throw err(400, "Invalid leadId");
  const existing = await LeadStepRepository.countByLead(leadId);
  if (existing > 0) return { created: 0, alreadyPresent: existing };

  const defs = await StepDefinitionRepository.findActive();
  if (!defs.length) return { created: 0, alreadyPresent: 0 };

  const rows = defs.map((d) => ({
    leadId,
    definitionId: d._id,
    name: d.name,
    phase: d.phase,
    order: d.order || 0,
    ownerIds: [],
    status: "not_started",
    rolling: !!d.rolling,
    optional: !!d.optional,
    dependsOn: [],
    notes: [],
  }));
  const inserted = await LeadStepRepository.insertMany(rows);

  await LeadInternalEventService.record({
    leadId,
    type: "journey_started",
    actorId: actorId || null,
    payload: { count: inserted.length },
  });
  return { created: inserted.length };
};

// A step is blocked from STARTING if any of its dependencies is not complete.
const blockedSet = (steps) => {
  const statusById = new Map(steps.map((s) => [String(s._id), s.status]));
  const blocked = new Map();
  for (const s of steps) {
    const deps = (s.dependsOn || []).map(String);
    const unmet = deps.filter((d) => statusById.get(d) !== "complete");
    blocked.set(String(s._id), unmet);
  }
  return blocked;
};

// Decorate steps with owner names, note-author names, and a blocked flag.
const listForLead = async (leadId) => {
  if (!isId(leadId)) throw err(400, "Invalid leadId");
  const steps = await LeadStepRepository.findByLead(leadId);

  const adminIds = new Set();
  for (const s of steps) {
    for (const o of s.ownerIds || []) adminIds.add(String(o));
    for (const n of s.notes || []) {
      if (n.authorId) adminIds.add(String(n.authorId));
      for (const m of n.mentions || []) adminIds.add(String(m));
    }
  }
  const admins = adminIds.size ? await Admin.find({ _id: { $in: [...adminIds] } }, { name: 1 }).lean() : [];
  const nameOf = new Map(admins.map((a) => [String(a._id), a.name]));
  const name = (id) => (id ? nameOf.get(String(id)) || "—" : null);

  const blocked = blockedSet(steps);
  return steps.map((s) => ({
    ...s,
    owners: (s.ownerIds || []).map((id) => ({ _id: String(id), name: name(id) })),
    blockedBy: blocked.get(String(s._id)) || [],
    blocked: (blocked.get(String(s._id)) || []).length > 0,
    notes: (s.notes || []).map((n) => ({
      _id: String(n._id),
      authorId: n.authorId ? String(n.authorId) : null,
      authorName: name(n.authorId) || "—",
      body: n.body,
      mentions: (n.mentions || []).map((m) => ({ _id: String(m), name: name(m) })),
      chatMessageId: n.chatMessageId ? String(n.chatMessageId) : null,
      createdAt: n.createdAt,
    })),
  }));
};

// Cycle check: would setting step `id`'s dependsOn to `deps` create a cycle?
// Build adjacency (step -> its deps) with the proposed edge, DFS for a back-edge.
const wouldCycle = (steps, id, deps) => {
  const adj = new Map();
  for (const s of steps) adj.set(String(s._id), (s.dependsOn || []).map(String));
  adj.set(String(id), deps.map(String));
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map([...adj.keys()].map((k) => [k, WHITE]));
  const dfs = (u) => {
    color.set(u, GRAY);
    for (const v of adj.get(u) || []) {
      if (!color.has(v)) continue; // dep to unknown node — ignore
      if (color.get(v) === GRAY) return true;
      if (color.get(v) === WHITE && dfs(v)) return true;
    }
    color.set(u, BLACK);
    return false;
  };
  for (const k of adj.keys()) if (color.get(k) === WHITE && dfs(k)) return true;
  return false;
};

// PATCH a step: status / ownerIds / dueAt / dependsOn / notApplicable. Emits
// actor-named journey events for status + owner changes.
const patchStep = async (leadId, stepId, fields = {}, actorId) => {
  if (!isId(stepId)) throw err(400, "Invalid stepId");
  const step = await LeadStepRepository.findByIdLean(stepId);
  if (!step || String(step.leadId) !== String(leadId)) throw err(404, "Step not found on this lead");

  const allSteps = await LeadStepRepository.findByLead(leadId);
  const update = {};
  const events = [];

  // ── Status ──
  if (fields.status !== undefined) {
    if (!STATUSES.includes(fields.status)) throw err(400, `status must be one of: ${STATUSES.join(", ")}`);
    if (fields.status !== step.status) {
      // Soft dependency guard: can't START a step until its deps are complete.
      if (step.status === "not_started" && fields.status !== "not_started") {
        const unmet = (step.dependsOn || [])
          .map(String)
          .filter((d) => (allSteps.find((s) => String(s._id) === d) || {}).status !== "complete");
        if (unmet.length) throw err(409, "Blocked: complete the prerequisite step(s) first");
      }
      update.status = fields.status;
      if (fields.status === "complete") update.completedAt = new Date();
      if (fields.status === "in_progress" && !step.startedAt) update.startedAt = new Date();
      if (fields.status !== "complete") update.completedAt = null;
      events.push({
        type: "step_status_changed",
        payload: { stepName: step.name, from: step.status, to: fields.status },
      });
    }
  }

  // ── Owners (must be on the lead's CURRENT roster) ──
  if (fields.ownerIds !== undefined) {
    if (!Array.isArray(fields.ownerIds)) throw err(400, "ownerIds must be an array");
    const ids = [...new Set(fields.ownerIds.map(String))];
    for (const id of ids) if (!isId(id)) throw err(400, `Invalid owner id: ${id}`);
    const roster = await LeadTeamMemberRepository.findCurrentByLead(leadId);
    const rosterIds = new Set(roster.map((r) => String(r.personId)));
    const offRoster = ids.filter((id) => !rosterIds.has(id));
    if (offRoster.length) throw err(400, "Owners must be current members of the lead's team");
    update.ownerIds = ids;
    const ownerNames = (await Admin.find({ _id: { $in: ids } }, { name: 1 }).lean()).map((a) => a.name);
    events.push({ type: "step_owners_assigned", payload: { stepName: step.name, ownerIds: ids, ownerNames } });
  }

  // ── Dependencies (opt-in, cycle-validated) ──
  if (fields.dependsOn !== undefined) {
    if (!Array.isArray(fields.dependsOn)) throw err(400, "dependsOn must be an array");
    const deps = [...new Set(fields.dependsOn.map(String))];
    for (const d of deps) {
      if (!isId(d)) throw err(400, `Invalid dependency id: ${d}`);
      if (d === String(stepId)) throw err(400, "A step cannot depend on itself");
      if (!allSteps.find((s) => String(s._id) === d)) throw err(400, "Dependency must be another step on this lead");
    }
    if (wouldCycle(allSteps, stepId, deps)) throw err(400, "That dependency would create a cycle");
    update.dependsOn = deps;
  }

  // ── Due date ──
  if (fields.dueAt !== undefined) {
    update.dueAt = fields.dueAt ? new Date(fields.dueAt) : null;
  }

  // ── Not-applicable (optional steps only) ──
  if (fields.notApplicable !== undefined) {
    if (fields.notApplicable && !step.optional) throw err(400, "Only optional steps can be marked not-applicable");
    update.notApplicable = !!fields.notApplicable;
  }

  if (!Object.keys(update).length) return (await listForLead(leadId)).find((s) => String(s._id) === String(stepId));

  await LeadStepRepository.updateById(stepId, { $set: update });
  for (const e of events) {
    await LeadInternalEventService.record({ leadId, type: e.type, actorId: actorId || null, payload: e.payload });
  }
  return (await listForLead(leadId)).find((s) => String(s._id) === String(stepId));
};

// Add a note to a step AND mirror it into the one lead chat (Slice 3). The chat
// echo is a contextualized system message linking back to the step; @tags are
// preserved so the chat_mention notification fires for anyone tagged.
const addNote = async (leadId, stepId, authorId, { body, mentions } = {}) => {
  if (!isId(stepId)) throw err(400, "Invalid stepId");
  const text = typeof body === "string" ? body.trim() : "";
  if (!text) throw err(400, "A note needs text");
  const step = await LeadStepRepository.findById(stepId);
  if (!step || String(step.leadId) !== String(leadId)) throw err(404, "Step not found on this lead");

  const ments = Array.isArray(mentions)
    ? [...new Set(mentions.filter((m) => isId(m) && String(m) !== String(authorId)).map(String))]
    : [];

  // 1) Persist the note on the step (its contextual history).
  const note = { authorId: authorId || null, body: text.slice(0, 5000), mentions: ments, createdAt: new Date() };
  step.notes.push(note);
  await step.save();
  const saved = step.notes[step.notes.length - 1];

  // 2) Mirror into the lead chat as a contextualized system message.
  const author = await Admin.findById(authorId, { name: 1 }).lean();
  const authorName = author ? author.name : "Someone";
  const mirrorBody = `${authorName} added a note in ${step.name} — ${text}`;
  const chatMsg = await LeadChatService.postSystemMessage(leadId, {
    body: mirrorBody,
    systemType: "step_note",
    stepId: step._id,
    mentions: ments,
  });

  // Link the step note to its chat echo (clickable both ways).
  if (chatMsg) {
    saved.chatMessageId = chatMsg._id;
    await step.save();
  }

  // 3) @tags → the existing chat_mention notification (so a tagged teammate is
  // pinged via the lead chat even if they never open the step).
  if (ments.length) {
    const lead = await Enquiry.findById(leadId, { name: 1 }).lean();
    await AdminNotificationService.notify(ments, {
      type: "chat_mention",
      title: `${authorName} mentioned you on ${lead ? lead.name : "a lead"}`,
      message: text.slice(0, 160),
      leadId,
      payload: { messageId: chatMsg ? String(chatMsg._id) : null, stepId: String(step._id) },
    });
  }

  return (await listForLead(leadId)).find((s) => String(s._id) === String(stepId));
};

module.exports = { instantiateForLead, listForLead, patchStep, addNote, STATUS_LABEL };
