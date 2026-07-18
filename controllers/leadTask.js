const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const LeadTask = require("../models/LeadTask");
const LeadTaskService = require("../services/LeadTaskService");
const { assertInScopeOrRoster } = require("../utils/leadScope");
const NurtureService = require("../services/NurtureService");

const respond = (res, error) => {
  const status = error.status || 500;
  res.status(status).json({ message: status === 500 ? "Something went wrong with this task — please retry." : error.message });
};

const assertLeadInScope = async (id, scopeFilter = {}) => {
  if (!mongoose.Types.ObjectId.isValid(id)) throw Object.assign(new Error("Invalid lead id"), { status: 400 });
  const inScope = await Enquiry.findOne({ $and: [{ _id: id }, scopeFilter || {}] }, { _id: 1 }).lean();
  if (!inScope) throw Object.assign(new Error("Out of your scope"), { status: 403 });
};

// POST /lead-tasks — { leadId, title, assigneeId, dueAt, createdInChatMessageId }
const Create = async (req, res) => {
  try {
    const { leadId } = req.body || {};
    await assertLeadInScope(leadId, req.scopeFilter);
    const task = await LeadTaskService.createTask(leadId, req.body || {}, req.auth.user_id);
    res.status(201).json(task);
  } catch (error) {
    respond(res, error);
  }
};

// GET /lead-tasks?leadId=... — tasks for one lead
// READ: roster members allowed (Slice B1); task create/complete keep the
// strict scope.
const ListForLead = async (req, res) => {
  try {
    const leadId = req.query.leadId;
    await assertInScopeOrRoster(leadId, req.scopeFilter, req.auth.user_id, { includeParticipants: true });
    const list = await LeadTaskService.listForLead(leadId, { includeDone: req.query.includeDone !== "false" });
    res.status(200).json({ list });
  } catch (error) {
    respond(res, error);
  }
};

// GET /lead-tasks/mine — assigned to me (overdue highlighted)
const Mine = async (req, res) => {
  try {
    const list = await LeadTaskService.myTasks(req.auth.user_id, { includeDone: req.query.includeDone === "true" });
    res.status(200).json({ list });
  } catch (error) {
    respond(res, error);
  }
};

// PUT /lead-tasks/:_id/complete — nurture tasks reset the cadence clock.
const Complete = async (req, res) => {
  try {
    const task = await LeadTask.findById(req.params._id, { kind: 1 }).lean();
    if (!task) throw Object.assign(new Error("Task not found"), { status: 404 });
    const result =
      task.kind === "nurture"
        ? await NurtureService.completeTouch(req.params._id, req.auth.user_id)
        : await LeadTaskService.completeTask(req.params._id, req.auth.user_id);
    res.status(200).json(result);
  } catch (error) {
    respond(res, error);
  }
};

module.exports = { Create, ListForLead, Mine, Complete };
