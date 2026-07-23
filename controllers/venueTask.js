/**
 * controllers/venueTask.js — MB-CRM S0c venue-owner CRM tasks.
 *
 * Standalone OR lead-linked. venueOwnerAuth + ownership enforced on every route.
 * Assigning a task to someone OTHER than yourself needs tasks_assign_others.
 * List scoping mirrors leads: "mine" (assigned to / created by self) is the safe
 * default; "all" requires team_see_pipelines (owners always pass).
 */
const Venue = require("../models/Venue");
const VenueTask = require("../models/VenueTask");
const VenueEnquiry = require("../models/VenueEnquiry");
const { hasCapability } = require("../utils/venueRbac");
const { validateAssignable } = require("../utils/venueLeadAssign");
const { resolveScopedEnquiry } = require("../utils/venueLeadScope");
const { optDate, cleanStr, MAXLEN } = require("../utils/venueInput");

const actorIdOf = (req) => req.venueOwner.memberId || req.venueOwner.venueOwnerId || null;

// Resolve + own the venue from the slug. Returns the venue or sends the error.
async function resolveOwnedVenue(req, res) {
  const { slug } = req.params;
  const venue = await Venue.findOne({ slug }).select("_id").lean();
  if (!venue) {
    res.status(404).json({ message: "Venue not found" });
    return null;
  }
  if (String(venue._id) !== String(req.venueOwner.venueId)) {
    res.status(403).json({ message: "Forbidden" });
    return null;
  }
  return venue;
}

// GET /venues/:slug/tasks?filter=mine|all&status=open|done&from=&to=
const listTasks = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;

    const query = { venue: venue._id };
    const { filter, status, from, to } = req.query || {};

    // Scope: "all" needs team_see_pipelines; otherwise (and by default) "mine".
    const canSeeAll = await hasCapability(req.venueOwner, "team_see_pipelines", req.venueMember);
    if (filter !== "all" || !canSeeAll) {
      const me = actorIdOf(req);
      query.$or = [{ assignedTo: me }, { createdBy: me }];
    }
    if (status === "open" || status === "done") query.status = status;
    if (from || to) {
      query.dueAt = {};
      const f = optDate(from, "from");
      const t = optDate(to, "to");
      if (from && !f.ok) return res.status(400).json({ message: f.message });
      if (to && !t.ok) return res.status(400).json({ message: t.message });
      if (f.value) query.dueAt.$gte = f.value;
      if (t.value) query.dueAt.$lte = t.value;
    }

    const tasks = await VenueTask.find(query)
      .sort({ dueAt: 1, createdAt: -1 })
      .populate("assignedTo", "name")
      // match excludes soft-deleted leads: a lead deleted AFTER being linked must
      // not surface its coupleName/stage here (populate nulls the link instead).
      .populate({ path: "linkedEnquiry", select: "coupleName name stage", match: { deleted: { $ne: true } } })
      .lean();
    return res.status(200).json({ tasks, total: tasks.length, scoped: !(filter === "all" && canSeeAll) });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Validate an optional linkedEnquiry belongs to this venue. Returns
// { ok, id } (id may be null when not provided) or { ok:false, status, message }.
async function resolveLinkedEnquiry(req, venueId, linkedEnquiry) {
  if (linkedEnquiry == null || String(linkedEnquiry).trim() === "") return { ok: true, id: null };
  // Scoped: a member can only link a task to a lead they can see (else the
  // populated task list would leak the lead's name/stage).
  const lead = await resolveScopedEnquiry(req.venueOwner, req.venueMember, venueId, linkedEnquiry, { select: "_id", lean: true });
  if (!lead) return { ok: false, status: 404, message: "Linked lead not found for this venue" };
  return { ok: true, id: lead._id };
}

// Resolve the assignee for a task write. Returns { ok, id } or { ok:false,... }.
// Assigning to anyone but yourself needs tasks_assign_others.
async function resolveTaskAssignee(req, venueId, assignedTo, { defaultToCreator = false } = {}) {
  const me = req.venueOwner.memberId || null;
  if (assignedTo === undefined) {
    return { ok: true, id: defaultToCreator ? me : undefined }; // undefined = "leave unchanged"
  }
  if (assignedTo == null || String(assignedTo).trim() === "") return { ok: true, id: null };
  if (!me || String(assignedTo) !== String(me)) {
    if (!(await hasCapability(req.venueOwner, "tasks_assign_others", req.venueMember))) {
      return { ok: false, status: 403, message: "You don't have permission to assign tasks to others" };
    }
  }
  const v = await validateAssignable(venueId, assignedTo);
  if (!v.ok) return { ok: false, status: 422, message: v.message };
  return { ok: true, id: v.id };
}

// POST /venues/:slug/tasks
const createTask = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;

    const { title, notes, dueAt, assignedTo, linkedEnquiry } = req.body || {};
    const titleC = cleanStr(title);
    if (!titleC) return res.status(400).json({ message: "title is required" });
    if (titleC.length > MAXLEN.label) return res.status(400).json({ message: `title is too long (max ${MAXLEN.label})` });
    const due = optDate(dueAt, "dueAt");
    if (!due.ok) return res.status(400).json({ message: due.message });

    const link = await resolveLinkedEnquiry(req, venue._id, linkedEnquiry);
    if (!link.ok) return res.status(link.status).json({ message: link.message });
    const assignee = await resolveTaskAssignee(req, venue._id, assignedTo, { defaultToCreator: true });
    if (!assignee.ok) return res.status(assignee.status).json({ message: assignee.message });

    const task = await VenueTask.create({
      venue: venue._id,
      title: titleC,
      notes: cleanStr(notes).slice(0, MAXLEN.text),
      dueAt: due.value,
      assignedTo: assignee.id || null,
      linkedEnquiry: link.id,
      createdBy: actorIdOf(req),
    });
    return res.status(201).json({ task });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Resolve + own a task by id under the venue. Returns the doc or sends an error.
async function resolveOwnedTask(req, res) {
  const venue = await resolveOwnedVenue(req, res);
  if (!venue) return null;
  const task = await VenueTask.findOne({ _id: req.params.taskId, venue: venue._id });
  if (!task) {
    res.status(404).json({ message: "Task not found" });
    return null;
  }
  // Scope: a member without team_see_pipelines can only touch tasks assigned to
  // or created by them (404 — don't leak existence). Owners always pass.
  const canSeeAll = await hasCapability(req.venueOwner, "team_see_pipelines", req.venueMember);
  if (!canSeeAll) {
    const me = String(actorIdOf(req));
    const mine = String(task.assignedTo || "") === me || String(task.createdBy || "") === me;
    if (!mine) {
      res.status(404).json({ message: "Task not found" });
      return null;
    }
  }
  return { venue, task };
}

// PATCH /venues/:slug/tasks/:taskId
const updateTask = async (req, res) => {
  try {
    const owned = await resolveOwnedTask(req, res);
    if (!owned) return;
    const { venue, task } = owned;
    const { title, notes, dueAt, assignedTo, linkedEnquiry } = req.body || {};

    if (title !== undefined) {
      const t = cleanStr(title);
      if (!t) return res.status(400).json({ message: "title cannot be empty" });
      if (t.length > MAXLEN.label) return res.status(400).json({ message: `title is too long (max ${MAXLEN.label})` });
      task.title = t;
    }
    if (notes !== undefined) task.notes = cleanStr(notes).slice(0, MAXLEN.text);
    if (dueAt !== undefined) {
      const due = optDate(dueAt, "dueAt");
      if (!due.ok) return res.status(400).json({ message: due.message });
      task.dueAt = due.value;
    }
    if (linkedEnquiry !== undefined) {
      const link = await resolveLinkedEnquiry(req, venue._id, linkedEnquiry);
      if (!link.ok) return res.status(link.status).json({ message: link.message });
      task.linkedEnquiry = link.id;
    }
    if (assignedTo !== undefined) {
      const assignee = await resolveTaskAssignee(req, venue._id, assignedTo);
      if (!assignee.ok) return res.status(assignee.status).json({ message: assignee.message });
      task.assignedTo = assignee.id || null;
    }
    await task.save();
    return res.status(200).json({ task });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// POST /venues/:slug/tasks/:taskId/complete
const completeTask = async (req, res) => {
  try {
    const owned = await resolveOwnedTask(req, res);
    if (!owned) return;
    const { task } = owned;
    task.status = "done";
    task.completedAt = new Date();
    task.completedBy = actorIdOf(req);
    await task.save();
    return res.status(200).json({ task });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// POST /venues/:slug/tasks/:taskId/reopen
const reopenTask = async (req, res) => {
  try {
    const owned = await resolveOwnedTask(req, res);
    if (!owned) return;
    const { task } = owned;
    task.status = "open";
    task.completedAt = undefined;
    task.completedBy = undefined;
    await task.save();
    return res.status(200).json({ task });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// DELETE /venues/:slug/tasks/:taskId
const deleteTask = async (req, res) => {
  try {
    const owned = await resolveOwnedTask(req, res);
    if (!owned) return;
    await owned.task.deleteOne();
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { listTasks, createTask, updateTask, completeTask, reopenTask, deleteTask };
