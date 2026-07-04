const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const LeadStepService = require("../services/LeadStepService");
const { assertInScopeOrRoster } = require("../utils/leadScope");
const LeadTaskService = require("../services/LeadTaskService");

const respond = (res, error) => {
  const status = error.status || 500;
  if (status === 500) console.error("[leadStep]", error);
  res.status(status).json({ message: status === 500 ? "Server error" : error.message });
};

// Lead-scope guard (mirrors leadTeam/leadChat): the lead must satisfy the
// caller's scope filter (requirePermission with ownerField assignedTo).
const assertInScope = async (id, scopeFilter = {}) => {
  if (!mongoose.Types.ObjectId.isValid(id))
    throw Object.assign(new Error("Invalid lead id"), { status: 400 });
  const inScope = await Enquiry.findOne({ $and: [{ _id: id }, scopeFilter || {}] }, { _id: 1 }).lean();
  if (!inScope) throw Object.assign(new Error("Out of your scope"), { status: 403 });
};

// GET /enquiry/:_id/steps — all steps (with owners, notes, blocked hints).
// READ: roster members allowed (Slice B1); mutations keep the strict scope.
const List = async (req, res) => {
  try {
    await assertInScopeOrRoster(req.params._id, req.scopeFilter, req.auth.user_id);
    res.status(200).json({ list: await LeadStepService.listForLead(req.params._id) });
  } catch (error) {
    respond(res, error);
  }
};

// POST /enquiry/:_id/steps/instantiate — idempotent manual instantiation.
const Instantiate = async (req, res) => {
  try {
    await assertInScope(req.params._id, req.scopeFilter);
    res.status(200).json(await LeadStepService.instantiateForLead(req.params._id, req.auth.user_id));
  } catch (error) {
    respond(res, error);
  }
};

// PATCH /enquiry/:_id/steps/:stepId — status / ownerIds / dueAt / dependsOn / notApplicable.
const Patch = async (req, res) => {
  try {
    await assertInScope(req.params._id, req.scopeFilter);
    res.status(200).json(await LeadStepService.patchStep(req.params._id, req.params.stepId, req.body || {}, req.auth.user_id));
  } catch (error) {
    respond(res, error);
  }
};

// POST /enquiry/:_id/steps/:stepId/notes — add a note (mirrors into the lead chat).
const AddNote = async (req, res) => {
  try {
    await assertInScope(req.params._id, req.scopeFilter);
    const step = await LeadStepService.addNote(
      req.params._id,
      req.params.stepId,
      req.auth.user_id,
      { body: req.body?.body, mentions: req.body?.mentions }
    );
    res.status(201).json(step);
  } catch (error) {
    respond(res, error);
  }
};

// ── MB8c-2a-i — per-step tasks ───────────────────────────────────────────────
// GET /enquiry/:_id/steps/:stepId/tasks
// READ: roster members allowed (Slice B1).
const ListTasks = async (req, res) => {
  try {
    await assertInScopeOrRoster(req.params._id, req.scopeFilter, req.auth.user_id);
    res.status(200).json({ list: await LeadTaskService.listForStep(req.params.stepId) });
  } catch (error) {
    respond(res, error);
  }
};

// POST /enquiry/:_id/steps/:stepId/tasks — { title, assigneeId?, dueAt? }
const CreateTask = async (req, res) => {
  try {
    await assertInScope(req.params._id, req.scopeFilter);
    const task = await LeadTaskService.createStepTask(
      req.params._id,
      req.params.stepId,
      { title: req.body?.title, assigneeId: req.body?.assigneeId, dueAt: req.body?.dueAt },
      req.auth.user_id
    );
    res.status(201).json(task);
  } catch (error) {
    respond(res, error);
  }
};

// PATCH /enquiry/:_id/steps/:stepId/tasks/:taskId — edit (title/assignee/due) or
// toggle done (when body.toggle is true).
const PatchTask = async (req, res) => {
  try {
    await assertInScope(req.params._id, req.scopeFilter);
    const task = req.body && req.body.toggle
      ? await LeadTaskService.toggleStepTask(req.params.taskId, req.auth.user_id)
      : await LeadTaskService.editStepTask(req.params.taskId, {
          title: req.body?.title,
          assigneeId: req.body?.assigneeId,
          dueAt: req.body?.dueAt,
        });
    res.status(200).json(task);
  } catch (error) {
    respond(res, error);
  }
};

module.exports = { List, Instantiate, Patch, AddNote, ListTasks, CreateTask, PatchTask };
