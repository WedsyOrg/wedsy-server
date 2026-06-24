const mongoose = require("mongoose");
const Admin = require("../models/Admin");
const Enquiry = require("../models/Enquiry");
const LeadStepRepository = require("../repositories/LeadStepRepository");
const FollowupRepository = require("../repositories/FollowupRepository");
const LeadTask = require("../models/LeadTask");
const SettingsService = require("./SettingsService");
const AdminNotificationService = require("./AdminNotificationService");
const LeadChatService = require("./LeadChatService");
const { effective: followupEffective } = require("./FollowupService");

const err = (status, message) => Object.assign(new Error(message), { status });
const isId = (v) => mongoose.Types.ObjectId.isValid(v);
const DAY = 24 * 60 * 60 * 1000;
const idStr = (v) => String(v);

// The shared threshold (days). Single source — settings, default 3.
const thresholdDays = async () => Number(await SettingsService.get("accountability.staleDays")) || 3;

// ── THE ONE RULE ─────────────────────────────────────────────────────────────
// A lead NEEDS ATTENTION if any of:
//   • a step is in_progress (or assigned & not_started) with NO movement
//     (status change / note / task activity) in `thresholdDays` days;
//   • it has an OVERDUE follow-up (open + dueAt past);
//   • it has an OVERDUE task (open + dueAt past).
// Pure + batchable: callers pass the already-loaded data so the pipeline can
// assess many leads without N+1. Returns { needsAttention, items, mostUrgent }.
const assess = (steps, tasks, followups, now, thresholdMs, assignedTo) => {
  const items = [];

  // Last task-activity per step (task create/toggle bumps the task's updatedAt).
  const taskActivityByStep = new Map();
  for (const t of tasks) {
    if (!t.stepId) continue;
    const k = idStr(t.stepId);
    const ts = +new Date(t.updatedAt || 0);
    if (ts > (taskActivityByStep.get(k) || 0)) taskActivityByStep.set(k, ts);
  }

  for (const s of steps) {
    const assigned = (s.ownerIds || []).length > 0;
    const active = s.status === "in_progress" || (s.status === "not_started" && assigned);
    if (!active || s.notApplicable) continue;
    const lastActivity = Math.max(+new Date(s.updatedAt || 0), taskActivityByStep.get(idStr(s._id)) || 0);
    if (lastActivity && lastActivity < +now - thresholdMs) {
      items.push({
        kind: "stale_step",
        stepId: idStr(s._id),
        stepName: s.name,
        responsibleId: s.ownerIds && s.ownerIds[0] ? idStr(s.ownerIds[0]) : assignedTo ? idStr(assignedTo) : null,
        magnitude: Math.floor((+now - lastActivity) / DAY), // days stale
      });
    }
  }

  for (const t of tasks) {
    if (t.status === "open" && t.dueAt && new Date(t.dueAt) < now) {
      items.push({
        kind: "overdue_task",
        taskId: idStr(t._id),
        stepId: t.stepId ? idStr(t.stepId) : null,
        title: t.title,
        responsibleId: t.assigneeId ? idStr(t.assigneeId) : assignedTo ? idStr(assignedTo) : null,
        magnitude: Math.floor((+now - +new Date(t.dueAt)) / DAY),
      });
    }
  }

  for (const f of followups) {
    const e = followupEffective(f, now);
    if (e.open && e.overdue) {
      items.push({
        kind: "overdue_followup",
        followupId: idStr(f._id),
        title: f.title,
        responsibleId: f.ownerId ? idStr(f.ownerId) : assignedTo ? idStr(assignedTo) : null,
        magnitude: Math.floor((+now - +new Date(f.dueAt)) / DAY),
      });
    }
  }

  // Priority: a client-facing overdue follow-up outranks an overdue task, which
  // outranks a stale step; within a kind, the more overdue/stale wins.
  const PRIORITY = { overdue_followup: 0, overdue_task: 1, stale_step: 2 };
  items.sort((a, b) => (PRIORITY[a.kind] - PRIORITY[b.kind]) || (b.magnitude - a.magnitude));

  return { needsAttention: items.length > 0, items, mostUrgent: items[0] || null };
};

// Single-lead assessment for the command-center banner (resolves names + the
// per-viewer framing string).
const assessLead = async (leadId, now = new Date()) => {
  if (!isId(leadId)) throw err(400, "Invalid leadId");
  const lead = await Enquiry.findById(leadId, { assignedTo: 1 }).lean();
  if (!lead) throw err(404, "Lead not found");
  const [steps, tasks, followups, days] = await Promise.all([
    LeadStepRepository.findByLead(leadId),
    LeadTask.find({ leadId }).lean(),
    FollowupRepository.findByLead(leadId),
    thresholdDays(),
  ]);
  const a = assess(steps, tasks, followups, now, days * DAY, lead.assignedTo);
  if (!a.needsAttention) return { needsAttention: false, thresholdDays: days, mostUrgent: null, moreCount: 0 };

  // Resolve responsible names for the surfaced items.
  const respIds = [...new Set(a.items.map((i) => i.responsibleId).filter(Boolean))];
  const admins = respIds.length ? await Admin.find({ _id: { $in: respIds } }, { name: 1 }).lean() : [];
  const nameOf = new Map(admins.map((x) => [idStr(x._id), x.name]));
  const top = a.items[0];
  const label = (() => {
    if (top.kind === "overdue_followup") return `Overdue follow-up · ${top.title}`;
    if (top.kind === "overdue_task") return `Overdue task · ${top.title}`;
    return `${top.stepName} · no update in ${top.magnitude || days} day${(top.magnitude || days) === 1 ? "" : "s"}`;
  })();
  return {
    needsAttention: true,
    thresholdDays: days,
    moreCount: Math.max(0, a.items.length - 1),
    mostUrgent: {
      ...top,
      responsibleName: top.responsibleId ? nameOf.get(top.responsibleId) || "—" : null,
      label,
    },
  };
};

// ── Rate-limited nudge ───────────────────────────────────────────────────────
// In-memory per (leadId, responsibleId) cooldown — prevents spam-nudging.
const NUDGE_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const lastNudge = new Map();
const nudgeKey = (leadId, responsibleId) => `${leadId}:${responsibleId}`;

const nudge = async (leadId, { responsibleId, stepName, message } = {}, actorId) => {
  if (!isId(leadId)) throw err(400, "Invalid leadId");
  if (!isId(responsibleId)) throw err(400, "A responsible person is required");
  const key = nudgeKey(leadId, responsibleId);
  const prev = lastNudge.get(key);
  if (prev && Date.now() - prev < NUDGE_COOLDOWN_MS) {
    const mins = Math.ceil((NUDGE_COOLDOWN_MS - (Date.now() - prev)) / 60000);
    throw err(429, `Already nudged — try again in ${mins} min`);
  }

  const lead = await Enquiry.findById(leadId, { name: 1 }).lean();
  const actor = actorId ? await Admin.findById(actorId, { name: 1 }).lean() : null;
  const niceMsg = String(message || "").trim() || (stepName ? `Could you post an update on "${stepName}"?` : "Could you post an update?");

  await AdminNotificationService.notify(responsibleId, {
    type: "accountability_nudge",
    title: `${actor ? actor.name : "A teammate"} is waiting on an update`,
    message: `${lead ? lead.name : "A lead"} — ${niceMsg}`,
    leadId,
    payload: { from: actorId ? idStr(actorId) : null },
  });
  // A gentle chat system line (constructive tone).
  await LeadChatService.postSystemMessage(leadId, {
    body: `Nudge sent — ${niceMsg}`,
    systemType: "accountability_nudge",
    mentions: [responsibleId],
  });

  lastNudge.set(key, Date.now());
  return { ok: true, nudged: idStr(responsibleId) };
};

module.exports = { thresholdDays, assess, assessLead, nudge, NUDGE_COOLDOWN_MS, _lastNudge: lastNudge, DAY };
