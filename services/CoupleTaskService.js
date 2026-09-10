/* MY TASKS (§ 05.3, § 06.2) — "deliberately small. A reminders list, not a
 * project manager."
 *
 * ── THE UNION, AND WHY THE WRITES ARE NOT ────────────────────────────────
 * GET /wedding/:id/tasks is the union of TWO collections:
 *
 *   CoupleTask        the couple's own reminders. Theirs to add, tick and
 *                     remove.
 *   WeddingMilestone  the AI/planner-authored wedding TIMELINE for the Event,
 *                     already rendered inside the CRM lead page
 *                     (leadPageV3.ListClientTasks). § 05.3: "Tasks the Wedsy
 *                     team creates for the couple appear here too, attributed."
 *
 * EVERY COUPLE-APP WRITE LANDS ON CoupleTask. Not one line in this file
 * updates, inserts into or deletes from WeddingMilestone, and a PATCH or
 * DELETE aimed at a milestone id is refused (rules.milestoneDenial) rather
 * than quietly widening a model the CRM reads. The team's timeline comes back
 * from this endpoint exactly as the team left it.
 *
 * The two shaping functions are CoupleWeddingService's own — Home renders the
 * same union in its task card, and two shapers is two versions of one row.
 */

const CoupleTask = require("../models/CoupleTask");
const WeddingMilestone = require("../models/WeddingMilestone");
const CoupleWeddingService = require("./CoupleWeddingService");
const activityService = require("./CoupleActivityService");
const rules = require("./CouplePeopleRules");

const fail = (status, code, message, extra) =>
  Object.assign(new Error(message), { status, code, extra: extra || null });

const note = (couple, { action, task, summary }) => {
  const actor = rules.actorOf(couple);
  return activityService.record({
    weddingId: couple.weddingId,
    actorType: actor.type,
    actor: { id: actor.id, name: actor.name },
    action,
    objectType: "task",
    objectId: task && task._id,
    summary,
    meta: { memberId: actor.memberId ? String(actor.memberId) : null },
  });
};

/**
 * Both halves, in one list.
 *
 * PURE — plain documents in, plain rows out, no database and no clock, so
 * tests/couple-tasks-union.test.js can run every branch of it.
 *
 * `readOnly` is the milestone half's marker. It is not the control (the
 * control is that no write in this file touches WeddingMilestone); it is what
 * lets a screen grey the row out instead of offering a toggle that will be
 * refused.
 *
 * `createdBy` is a DISPLAY name, and the one field that is viewer-relative:
 * the client hides the attribution line when it reads "you" (Tasks.js), so a
 * task shows its author to the other partner and not back to its own.
 */
const unite = (coupleTasks, milestones, viewerId) => {
  const me = viewerId ? String(viewerId) : "";
  const mine = (Array.isArray(coupleTasks) ? coupleTasks : []).map((task) => {
    const row = CoupleWeddingService.shapeTask(task);
    const author = task && task.createdBy ? String(task.createdBy) : "";
    return {
      ...row,
      createdBy: me && author && author === me ? "you" : row.createdBy,
      readOnly: false,
    };
  });
  const theirs = (Array.isArray(milestones) ? milestones : []).map((milestone) => ({
    ...CoupleWeddingService.shapeMilestone(milestone),
    readOnly: true,
  }));
  return mine.concat(theirs).sort(rules.taskOrder);
};

/** GET /wedding/:id/tasks */
const list = async (couple) => {
  const [tasks, milestones] = await Promise.all([
    CoupleTask.find({ weddingId: couple.weddingId }).lean(),
    // The CRM's timeline is keyed on the Event by `eventId`, not `weddingId` —
    // the same document, its own field name. READ ONLY.
    WeddingMilestone.find({ eventId: couple.weddingId }).lean(),
  ]);
  return unite(tasks, milestones, couple.userId);
};

/** POST /wedding/:id/tasks — always a CoupleTask. */
const create = async (couple, body) => {
  const { fields, errors } = rules.taskFields(body);
  if (Object.keys(errors).length) throw fail(422, "validation", "Some of that needs another look.", { fields: errors });

  const actor = rules.actorOf(couple);
  const task = await CoupleTask.create({
    ...fields,
    weddingId: couple.weddingId,
    done: Boolean(fields.done),
    completedAt: fields.done ? new Date() : null,
    // NEVER the client's "createdBy: 'you'" — that string is a rendering, and
    // stored it would read as "added by you" to the other partner as well.
    createdByName: actor.name || "",
    createdBy: couple.userId,
    createdByMember: couple.role === "member" && couple.member ? couple.member._id : null,
  });

  // NOTIFICATION — TRIGGERS ONLY, and none is added here.
  // `remind` is stored and nothing sends it. When the reminder ships it goes
  // through services/NotificationService.js as trigger `couple_task_remind`
  // (WhatsApp via the Meta Cloud API — never Aisensy), after the Notification
  // System spec in Notion. See docs/couple-app-api.md § 6.

  await note(couple, { action: "task.added", task, summary: `added the task “${task.title}”` });
  return unite([task.toObject ? task.toObject() : task], [], couple.userId)[0];
};

/**
 * PATCH /tasks/:id — CoupleTask only.
 *
 * `task` is the CoupleTask the route loaded to discover its weddingId. A
 * milestone id never reaches here: the route refuses it with
 * rules.milestoneDenial AFTER membership was checked, so a stranger still gets
 * the wedding's 403 and only a real member is told whose task it is.
 */
const update = async (couple, task, body) => {
  const { fields, errors } = rules.taskFields(body, { partial: true });
  if (Object.keys(errors).length) throw fail(422, "validation", "Some of that needs another look.", { fields: errors });

  // Read before the write — see the same note in CoupleGuestService.update.
  const wasDone = Boolean(task.done);
  const patch = { ...fields };
  if (Object.prototype.hasOwnProperty.call(fields, "done")) {
    patch.completedAt = fields.done ? new Date() : null;
  }

  const saved = await CoupleTask.findOneAndUpdate(
    { _id: task._id, weddingId: couple.weddingId },
    { $set: patch },
    { new: true }
  ).lean();
  if (!saved) throw fail(404, "not_found", "We could not find that task.");

  // Ticking one off is the moment the other partner wants to see. A reminder
  // toggled on and off again is not.
  if (Object.prototype.hasOwnProperty.call(patch, "done") && patch.done !== wasDone) {
    await note(couple, {
      action: patch.done ? "task.completed" : "task.reopened",
      task: saved,
      summary: patch.done ? `ticked off “${saved.title}”` : `put “${saved.title}” back on the list`,
    });
  }

  return unite([saved], [], couple.userId)[0];
};

/** DELETE /tasks/:id — CoupleTask only. */
const remove = async (couple, task) => {
  const deleted = await CoupleTask.findOneAndDelete({
    _id: task._id,
    weddingId: couple.weddingId,
  }).lean();
  if (!deleted) throw fail(404, "not_found", "We could not find that task.");
  await note(couple, { action: "task.removed", task: deleted, summary: `removed the task “${deleted.title}”` });
  return { ok: true, id: String(deleted._id) };
};

module.exports = { list, unite, create, update, remove };
