const mongoose = require("mongoose");
const LeadTask = require("../models/LeadTask");
const LeadStep = require("../models/LeadStep");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Enquiry = require("../models/Enquiry");
const LeadInternalEventService = require("./LeadInternalEventService");
const AdminNotificationService = require("./AdminNotificationService");
const LeadChatService = require("./LeadChatService");
const LeadTeamMemberRepository = require("../repositories/LeadTeamMemberRepository");
const EnquiryRepository = require("../repositories/EnquiryRepository");

const httpError = (status, message) => Object.assign(new Error(message), { status });
const isId = (v) => mongoose.Types.ObjectId.isValid(v);

// Active admins holding a named role (RBAC v2: roleId OR roleIds[]).
const idsByRoleName = async (name) => {
  const role = await Role.findOne({ name, deletedAt: null }, { _id: 1 }).lean();
  if (!role) return [];
  const admins = await Admin.find(
    { status: "active", $or: [{ roleId: role._id }, { roleIds: role._id }] },
    { _id: 1 }
  ).lean();
  return admins.map((a) => a._id);
};

const nameOf = async (adminId) => {
  if (!adminId) return "—";
  const a = await Admin.findById(adminId, { name: 1 }).lean();
  return a ? a.name : "—";
};

// Create a task (born-in-chat when createdInChatMessageId is set, else standalone).
const createTask = async (
  leadId,
  { title, assigneeId, dueAt, createdInChatMessageId, kind = "task", nurtureText = "" } = {},
  assignerId
) => {
  if (!isId(leadId)) throw httpError(400, "Invalid leadId");
  const cleanTitle = String(title || "").trim();
  if (!cleanTitle) throw httpError(400, "A task needs a title");
  if (!isId(assigneeId)) throw httpError(400, "A valid assignee is required");
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) throw httpError(400, "A valid dueAt is required");

  const task = await LeadTask.create({
    leadId,
    title: cleanTitle.slice(0, 300),
    assigneeId,
    assignerId: assignerId || null,
    dueAt: due,
    kind: ["task", "nurture"].includes(kind) ? kind : "task",
    nurtureText: String(nurtureText || "").slice(0, 5000),
    createdInChatMessageId: createdInChatMessageId && isId(createdInChatMessageId) ? createdInChatMessageId : null,
  });

  const assigneeName = await nameOf(assigneeId);

  // Lifecycle posts back to the thread as a system message.
  await LeadChatService.postSystemMessage(leadId, {
    body: `Task created for ${assigneeName}: ${cleanTitle}`,
    systemType: "task_created",
    taskId: task._id,
  });

  await LeadInternalEventService.record({
    leadId,
    type: "task_created",
    actorId: assignerId || null,
    payload: { taskId: String(task._id), title: cleanTitle, assigneeId: String(assigneeId), kind: task.kind },
  });

  // Notify the assignee (distinct from the @mention notification).
  await AdminNotificationService.notify(assigneeId, {
    type: "task_assigned",
    title: `New task: ${cleanTitle}`,
    message: `Due ${due.toDateString()}`,
    leadId,
    payload: { taskId: String(task._id) },
  });

  // Signal spine: a task is employee activity (touched) — NEVER a customer
  // response, so firstRespondedAt is deliberately not stamped here.
  await EnquiryRepository.touchLastActivity(leadId);

  return task;
};

const completeTask = async (taskId, actorId) => {
  if (!isId(taskId)) throw httpError(400, "Invalid taskId");
  const task = await LeadTask.findOne({ _id: taskId, status: "open" });
  if (!task) throw httpError(404, "Open task not found");
  task.status = "done";
  task.completedAt = new Date();
  task.completedBy = actorId || null;
  await task.save();

  await LeadChatService.postSystemMessage(task.leadId, {
    body: `Task completed: ${task.title}`,
    systemType: "task_completed",
    taskId: task._id,
  });
  await LeadInternalEventService.record({
    leadId: task.leadId,
    type: "task_completed",
    actorId: actorId || null,
    payload: { taskId: String(task._id), title: task.title, kind: task.kind },
  });
  // Signal spine: completing a task is employee activity.
  await EnquiryRepository.touchLastActivity(task.leadId);
  return task;
};

const listForLead = async (leadId, { includeDone = true } = {}) => {
  if (!isId(leadId)) throw httpError(400, "Invalid leadId");
  const filter = { leadId };
  if (!includeDone) filter.status = "open";
  const rows = await LeadTask.find(filter).sort({ status: 1, dueAt: 1 }).lean();
  return decorate(rows);
};

// "My tasks" surface — assigned to me, overdue highlighted.
const myTasks = async (adminId, { includeDone = false } = {}) => {
  if (!isId(adminId)) throw httpError(400, "Invalid adminId");
  const filter = { assigneeId: adminId };
  if (!includeDone) filter.status = "open";
  const rows = await LeadTask.find(filter).sort({ status: 1, dueAt: 1 }).lean();
  return decorate(rows);
};

const decorate = async (rows) => {
  const now = Date.now();
  const leadIds = [...new Set(rows.map((r) => r.leadId).filter(Boolean).map(String))];
  const leads = leadIds.length
    ? await Enquiry.find({ _id: { $in: leadIds } }, { name: 1, phone: 1 }).lean()
    : [];
  const leadById = new Map(leads.map((l) => [String(l._id), l]));
  return rows.map((r) => ({
    ...r,
    lead: r.leadId ? leadById.get(String(r.leadId)) || null : null,
    // Overdue only when a due date is actually set (step tasks may be undated).
    overdue: r.status === "open" && !!r.dueAt && new Date(r.dueAt).getTime() < now,
  }));
};

// Overdue sweep: notify the ASSIGNER + the manager-visibility chain. Set-once
// (overdueEscalatedAt) so a task only escalates once. Nurture tasks escalate to
// the CS Manager + Revenue Manager (Slice 4); plain tasks to the assigner's
// reporting manager.
const escalateOverdue = async (now = new Date()) => {
  const due = await LeadTask.find({
    status: "open",
    dueAt: { $lt: now },
    overdueEscalatedAt: null,
  }).lean();
  if (!due.length) return { escalated: 0 };

  let csManagers = null;
  let revManagers = null;
  let escalated = 0;

  for (const t of due) {
    const recipients = new Set();
    if (t.assignerId) recipients.add(String(t.assignerId));

    if (t.kind === "nurture") {
      if (csManagers === null) csManagers = await idsByRoleName("CS Manager");
      if (revManagers === null) revManagers = await idsByRoleName("Revenue Manager");
      [...csManagers, ...revManagers].forEach((id) => recipients.add(String(id)));
    } else {
      // Plain task → the assigner's reporting manager (Asha / the reporting chain).
      const assigner = t.assignerId
        ? await Admin.findById(t.assignerId, { reportingManagerId: 1 }).lean()
        : null;
      if (assigner && assigner.reportingManagerId) recipients.add(String(assigner.reportingManagerId));
    }

    const ids = [...recipients].filter(Boolean);
    if (ids.length) {
      await AdminNotificationService.notify(ids, {
        type: t.kind === "nurture" ? "nurture_overdue" : "task_overdue",
        title: `Overdue ${t.kind === "nurture" ? "nurture touch" : "task"}: ${t.title}`,
        message: `Was due ${new Date(t.dueAt).toDateString()}`,
        leadId: t.leadId,
        payload: { taskId: String(t._id) },
      });
    }
    await LeadTask.updateOne({ _id: t._id }, { $set: { overdueEscalatedAt: new Date() } });
    escalated++;
  }
  return { escalated };
};

// ── MB8c-2a-i — PER-STEP TASKS ───────────────────────────────────────────────
// Micro-tasks attached to a journey step (LeadStep). Reuse this model via the
// optional stepId link. Unlike MB7b collaboration tasks these are quiet in the
// lead chat (notes are the chat citizens) — they emit journey events only.

const assertStepInLead = async (leadId, stepId) => {
  if (!isId(leadId) || !isId(stepId)) throw httpError(400, "Invalid id");
  const step = await LeadStep.findById(stepId, { leadId: 1, name: 1 }).lean();
  if (!step || String(step.leadId) !== String(leadId)) throw httpError(404, "Step not found on this lead");
  return step;
};

// An assignee, when set, must be on the lead's CURRENT roster (MB8a).
const assertOwnerOnRoster = async (leadId, assigneeId) => {
  if (!assigneeId) return null;
  if (!isId(assigneeId)) throw httpError(400, "Invalid owner id");
  const roster = await LeadTeamMemberRepository.findCurrentByLead(leadId);
  if (!roster.some((r) => String(r.personId) === String(assigneeId)))
    throw httpError(400, "The owner must be a current member of the lead's team");
  return assigneeId;
};

const createStepTask = async (leadId, stepId, { title, assigneeId, dueAt } = {}, assignerId) => {
  const step = await assertStepInLead(leadId, stepId);
  const cleanTitle = String(title || "").trim();
  if (!cleanTitle) throw httpError(400, "A task needs a title");
  await assertOwnerOnRoster(leadId, assigneeId);
  let due = null;
  if (dueAt) {
    due = new Date(dueAt);
    if (Number.isNaN(due.getTime())) throw httpError(400, "Invalid dueAt");
  }

  const task = await LeadTask.create({
    leadId,
    stepId,
    title: cleanTitle.slice(0, 300),
    assigneeId: assigneeId || null,
    assignerId: assignerId || null,
    dueAt: due,
    kind: "task",
  });

  await LeadInternalEventService.record({
    leadId,
    type: "step_task_created",
    actorId: assignerId || null,
    payload: { taskId: String(task._id), title: cleanTitle, stepId: String(stepId), stepName: step.name, assigneeId: assigneeId ? String(assigneeId) : null },
  });
  if (assigneeId) {
    await AdminNotificationService.notify(assigneeId, {
      type: "task_assigned",
      title: `New task: ${cleanTitle}`,
      message: `On step "${step.name}"`,
      leadId,
      payload: { taskId: String(task._id), stepId: String(stepId) },
    });
  }
  // Signal spine: step tasks are employee activity too.
  await EnquiryRepository.touchLastActivity(leadId);
  return (await decorate([task.toObject()]))[0];
};

const listForStep = async (stepId) => {
  if (!isId(stepId)) throw httpError(400, "Invalid stepId");
  const rows = await LeadTask.find({ stepId }).sort({ status: 1, dueAt: 1, createdAt: 1 }).lean();
  return decorate(rows);
};

const editStepTask = async (taskId, { title, assigneeId, dueAt } = {}) => {
  if (!isId(taskId)) throw httpError(400, "Invalid taskId");
  const task = await LeadTask.findById(taskId);
  if (!task || !task.stepId) throw httpError(404, "Step task not found");
  if (title !== undefined) {
    const t = String(title).trim();
    if (!t) throw httpError(400, "Title cannot be empty");
    task.title = t.slice(0, 300);
  }
  if (assigneeId !== undefined) {
    if (assigneeId) await assertOwnerOnRoster(task.leadId, assigneeId);
    task.assigneeId = assigneeId || null;
  }
  if (dueAt !== undefined) {
    if (!dueAt) task.dueAt = null;
    else {
      const d = new Date(dueAt);
      if (Number.isNaN(d.getTime())) throw httpError(400, "Invalid dueAt");
      task.dueAt = d;
    }
  }
  await task.save();
  return (await decorate([task.toObject()]))[0];
};

// Toggle open<->done. Step tasks stay quiet in chat; journey event only.
const toggleStepTask = async (taskId, actorId) => {
  if (!isId(taskId)) throw httpError(400, "Invalid taskId");
  const task = await LeadTask.findById(taskId);
  if (!task || !task.stepId) throw httpError(404, "Step task not found");
  const toDone = task.status === "open";
  task.status = toDone ? "done" : "open";
  task.completedAt = toDone ? new Date() : null;
  task.completedBy = toDone ? actorId || null : null;
  await task.save();
  await LeadInternalEventService.record({
    leadId: task.leadId,
    type: toDone ? "step_task_completed" : "step_task_reopened",
    actorId: actorId || null,
    payload: { taskId: String(task._id), title: task.title, stepId: String(task.stepId) },
  });
  // Signal spine: toggling a step task is employee activity.
  await EnquiryRepository.touchLastActivity(task.leadId);
  return (await decorate([task.toObject()]))[0];
};

module.exports = {
  idsByRoleName,
  createTask,
  completeTask,
  listForLead,
  myTasks,
  escalateOverdue,
  createStepTask,
  listForStep,
  editStepTask,
  toggleStepTask,
};
