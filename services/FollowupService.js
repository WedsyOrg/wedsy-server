const mongoose = require("mongoose");
const Admin = require("../models/Admin");
const Enquiry = require("../models/Enquiry");
const FollowupRepository = require("../repositories/FollowupRepository");
const LeadTeamMemberRepository = require("../repositories/LeadTeamMemberRepository");
const LeadInternalEventService = require("./LeadInternalEventService");
const LeadChatService = require("./LeadChatService");
const AdminNotificationService = require("./AdminNotificationService");

const err = (status, message) => Object.assign(new Error(message), { status });
const isId = (v) => mongoose.Types.ObjectId.isValid(v);

const nameOf = async (id) => (id ? (await Admin.findById(id, { name: 1 }).lean())?.name || "—" : null);

// A snoozed follow-up whose snoozedUntil has passed is effectively OPEN again.
// Normalize the effective status/overdue at read time (no background job needed).
const effective = (f, now = new Date()) => {
  let status = f.status;
  if (status === "snoozed" && f.snoozedUntil && new Date(f.snoozedUntil) <= now) status = "open";
  const isOpen = status === "open";
  const overdue = isOpen && !!f.dueAt && new Date(f.dueAt) < now;
  return { ...f, effectiveStatus: status, open: isOpen, overdue };
};

const decorate = async (rows) => {
  const now = new Date();
  const ids = [...new Set(rows.flatMap((r) => [r.ownerId, r.createdBy]).filter(Boolean).map(String))];
  const admins = ids.length ? await Admin.find({ _id: { $in: ids } }, { name: 1 }).lean() : [];
  const n = new Map(admins.map((a) => [String(a._id), a.name]));
  return rows.map((r) => {
    const e = effective(r, now);
    return {
      _id: String(r._id), leadId: String(r.leadId), title: r.title, dueAt: r.dueAt,
      ownerId: r.ownerId ? String(r.ownerId) : null, ownerName: r.ownerId ? n.get(String(r.ownerId)) || "—" : null,
      status: e.effectiveStatus, snoozedUntil: r.snoozedUntil || null,
      open: e.open, overdue: e.overdue, completedAt: r.completedAt || null,
      createdAt: r.createdAt,
    };
  });
};

const assertOwnerOnRoster = async (leadId, ownerId) => {
  if (!ownerId) return null;
  if (!isId(ownerId)) throw err(400, "Invalid owner id");
  const roster = await LeadTeamMemberRepository.findCurrentByLead(leadId);
  if (!roster.some((r) => String(r.personId) === String(ownerId)))
    throw err(400, "The follow-up owner must be a current member of the lead's team");
  return ownerId;
};

const create = async (leadId, { title, dueAt, ownerId } = {}, createdBy) => {
  if (!isId(leadId)) throw err(400, "Invalid leadId");
  const cleanTitle = String(title || "").trim();
  if (!cleanTitle) throw err(400, "A follow-up needs a title");
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) throw err(400, "A valid dueAt is required");
  await assertOwnerOnRoster(leadId, ownerId);

  const f = await FollowupRepository.create({
    leadId, title: cleanTitle.slice(0, 300), dueAt: due, ownerId: ownerId || null, createdBy: createdBy || null,
  });

  const ownerName = await nameOf(ownerId);
  // One card on create (the non-spammy cadence: set now, due-card later/once).
  await LeadChatService.postSystemMessage(leadId, {
    body: `Follow-up set: ${cleanTitle} — ${due.toDateString()}${ownerName ? ` · ${ownerName}` : ""}`,
    systemType: "followup_set",
    followupId: f._id,
  });
  await LeadInternalEventService.record({
    leadId, type: "followup_created", actorId: createdBy || null,
    payload: { followupId: String(f._id), title: cleanTitle, dueAt: due, ownerId: ownerId ? String(ownerId) : null, ownerName },
  });
  if (ownerId) {
    await AdminNotificationService.notify(ownerId, {
      type: "followup_assigned", title: `Follow-up: ${cleanTitle}`, message: `Due ${due.toDateString()}`,
      leadId, payload: { followupId: String(f._id) },
    });
  }
  // SEQ-3c — a follow-up scheduled from the lead detail page is a next step, so
  // it clears any "no further action" flag (SEQ-3b). Reuses the same fire-safe
  // helper; never blocks the create.
  await require("./CallCockpitService").setNoFurtherAction(leadId, false, createdBy);
  return (await decorate([f.toObject()]))[0];
};

const complete = async (followupId, actorId) => {
  if (!isId(followupId)) throw err(400, "Invalid followupId");
  const f = await FollowupRepository.findById(followupId);
  if (!f || f.status === "done") throw err(404, "Open follow-up not found");
  f.status = "done"; f.completedAt = new Date(); f.completedBy = actorId || null;
  await f.save();
  await LeadChatService.postSystemMessage(f.leadId, { body: `Follow-up done: ${f.title}`, systemType: "followup_done", followupId: f._id });
  await LeadInternalEventService.record({
    leadId: f.leadId, type: "followup_completed", actorId: actorId || null,
    payload: { followupId: String(f._id), title: f.title },
  });
  return (await decorate([f.toObject()]))[0];
};

const snooze = async (followupId, { until } = {}, actorId) => {
  if (!isId(followupId)) throw err(400, "Invalid followupId");
  const f = await FollowupRepository.findById(followupId);
  if (!f || f.status === "done") throw err(404, "Open follow-up not found");
  // Default snooze: +1 day from now (or an explicit `until`).
  const u = until ? new Date(until) : new Date(Date.now() + 24 * 60 * 60 * 1000);
  if (Number.isNaN(u.getTime())) throw err(400, "Invalid snooze date");
  f.status = "snoozed"; f.snoozedUntil = u;
  f.dueCardPostedAt = null; // it can surface a fresh due card when it re-opens
  await f.save();
  return (await decorate([f.toObject()]))[0];
};

const listForLead = async (leadId) => {
  if (!isId(leadId)) throw err(400, "Invalid leadId");
  return decorate(await FollowupRepository.findByLead(leadId));
};

const myDue = async (ownerId, { withinDays = 2 } = {}) => {
  if (!isId(ownerId)) throw err(400, "Invalid ownerId");
  const before = new Date(Date.now() + withinDays * 24 * 60 * 60 * 1000);
  return decorate(await FollowupRepository.findMineDue(ownerId, before));
};

// Post the once-only "due" chat card for newly-due follow-ups on a lead. Called
// lazily when the chat / follow-ups are read — stamped so it never repeats.
const sweepDueCards = async (leadId) => {
  if (!isId(leadId)) return;
  const now = new Date();
  const due = await FollowupRepository.findDueUncarded(leadId, now);
  for (const f of due) {
    const ownerName = await nameOf(f.ownerId);
    await LeadChatService.postSystemMessage(leadId, {
      body: `Follow-up due: ${f.title}${ownerName ? ` · ${ownerName}` : ""}`,
      systemType: "followup_due",
      followupId: f._id,
    });
    await FollowupRepository.updateById(f._id, { dueCardPostedAt: now });
  }
};

module.exports = { create, complete, snooze, listForLead, myDue, sweepDueCards, decorate, effective };
