// W2 — MY WORK. The caller's merged action queue (/my-work/now) and calendar
// (/my-work/schedule). Composes EXISTING services/stores — golden-window
// respond-now, BOTH follow-up stores (embedded cadence + Followup journey),
// LeadTask, CalendarEvent meetings, triage (rights-gated) — into one ranked
// list / one IST-day-grouped schedule. Batched: a fixed number of queries
// regardless of how many items the caller has (no N+1).
const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Followup = require("../models/Followup");
const LeadTask = require("../models/LeadTask");
const CalendarEvent = require("../models/CalendarEvent");
const GoldenWindowService = require("./GoldenWindowService");
const SnoozeService = require("./SnoozeService");
const TriageService = require("./TriageService");
const { currentVisibilityFilter } = require("../utils/leadVisibility");
const { istDayStart, istDayEnd, toIstWallClock, fromIstParts } = require("../utils/goldenWindow");
const { notLostFilter } = require("../utils/lostTerminal");

const DAY_MS = 24 * 60 * 60 * 1000;
const UPCOMING_DAYS = 7; // the "upcoming" tail of the now-queue
const MAX_SCHEDULE_DAYS = 31;

// Live predicate: won/recycled/archived out + the shared lost-terminal
// exclusion (a pending-approval lead stays LIVE until approved).
const ACTIVE = {
  ...notLostFilter(),
  stage: { $nin: ["won", "lost"] },
  "recycled.isRecycled": { $ne: true },
  archivedAt: null,
};

const TYPE_LABEL = { call: "Call", meet: "G-Meet", visit: "Visit" };
const istDayKey = (d) => toIstWallClock(new Date(d)).toISOString().slice(0, 10);

// Ranking ladder: overdue → respond-now → due-today → triage → upcoming.
const URGENCY = { overdue: 0, respond: 1, dueToday: 2, triage: 3, upcoming: 4 };

// ─────────────────────────────────────────────────────────────────────────────
// GET /my-work/now
// ─────────────────────────────────────────────────────────────────────────────
const now = async (callerId, at = new Date()) => {
  const todayStart = istDayStart(at);
  const todayEnd = istDayEnd(at);
  const upcomingEnd = new Date(+todayEnd + UPCOMING_DAYS * DAY_MS);

  const [visibility, snoozeExcl] = await Promise.all([
    currentVisibilityFilter(),
    SnoozeService.snoozeExclusion(at),
  ]);

  // Triage rights — the same permission the /enquiry/triage route gates on.
  const { permissionsForAdmin, permissionSatisfies } = require("../middlewares/requirePermission");
  const admin = await Admin.findById(callerId).lean();
  const perms = await permissionsForAdmin(admin);
  const canTriage = permissionSatisfies(perms, "leads:triage:own").allowed;

  const [respond, cadenceLeads, journeyRows, taskRows, triageRows] = await Promise.all([
    // 1 · respond-now — already caller-scoped + snooze-aware inside the service.
    GoldenWindowService.respondNow(callerId, at),
    // 2 · cadence follow-ups on MY leads (open, due within the horizon;
    //     parked leads excluded except waking via snoozeExclusion).
    Enquiry.find(
      {
        $and: [
          {
            assignedTo: callerId,
            ...ACTIVE,
            followUps: { $elemMatch: { completedAt: null, scheduledAt: { $lte: upcomingEnd } } },
          },
          visibility,
          snoozeExcl,
        ],
      },
      { name: 1, followUps: 1 }
    ).lean(),
    // 3 · journey-store follow-ups I own (snoozed-in-future rows are not due).
    Followup.find(
      {
        ownerId: callerId,
        dueAt: { $lte: upcomingEnd },
        $or: [{ status: "open" }, { status: "snoozed", snoozedUntil: { $lte: at } }],
      },
      { leadId: 1, title: 1, dueAt: 1 }
    ).lean(),
    // 4 · my open tasks with a due date in the horizon.
    LeadTask.find(
      { assigneeId: callerId, status: "open", dueAt: { $ne: null, $lte: upcomingEnd } },
      { leadId: 1, title: 1, dueAt: 1, laneId: 1 }
    ).lean(),
    // 5 · triage — only for callers with triage rights.
    canTriage ? TriageService.listTriage() : Promise.resolve([]),
  ]);

  // One batched lead read validates journey/task leads (active + visible +
  // not-parked-except-waking) and supplies names.
  const refLeadIds = [
    ...new Set([...journeyRows, ...taskRows].map((r) => String(r.leadId)).filter(Boolean)),
  ];
  const refLeads = refLeadIds.length
    ? await Enquiry.find(
        { $and: [{ _id: { $in: refLeadIds }, ...ACTIVE }, visibility, snoozeExcl] },
        { name: 1 }
      ).lean()
    : [];
  const leadName = new Map(refLeads.map((l) => [String(l._id), l.name]));

  const items = [];

  for (const r of respond.rows || []) {
    items.push({
      kind: "respond",
      leadId: String(r._id),
      leadName: r.name,
      title: "First response — golden window",
      dueAt: r.deadlineAt || null,
      overdue: !!r.breached,
      followUpId: null,
      store: null,
      taskId: null,
      laneId: null,
    });
  }

  for (const lead of cadenceLeads) {
    for (const f of lead.followUps || []) {
      if (f.completedAt || !f.scheduledAt || +new Date(f.scheduledAt) > +upcomingEnd) continue;
      items.push({
        kind: "followup",
        leadId: String(lead._id),
        leadName: lead.name,
        title: `${TYPE_LABEL[f.type] || "Follow-up"}${f.promiseNote ? ` — ${f.promiseNote}` : ""}`,
        dueAt: f.scheduledAt,
        overdue: +new Date(f.scheduledAt) < +todayStart,
        followUpId: String(f._id),
        store: "cadence",
        taskId: null,
        laneId: null,
      });
    }
  }

  for (const f of journeyRows) {
    if (!leadName.has(String(f.leadId))) continue; // parked (not waking) / inactive / invisible
    items.push({
      kind: "followup",
      leadId: String(f.leadId),
      leadName: leadName.get(String(f.leadId)),
      title: f.title,
      dueAt: f.dueAt,
      overdue: +new Date(f.dueAt) < +todayStart,
      followUpId: String(f._id),
      store: "journey",
      taskId: null,
      laneId: null,
    });
  }

  for (const t of taskRows) {
    if (!leadName.has(String(t.leadId))) continue;
    items.push({
      kind: "task",
      leadId: String(t.leadId),
      leadName: leadName.get(String(t.leadId)),
      title: t.title,
      dueAt: t.dueAt,
      overdue: +new Date(t.dueAt) < +todayStart,
      followUpId: null,
      store: null,
      taskId: String(t._id),
      laneId: t.laneId ? String(t.laneId) : null,
    });
  }

  for (const l of triageRows) {
    items.push({
      kind: "triage",
      leadId: String(l._id),
      leadName: l.name,
      title: "Triage — assign an owner",
      dueAt: null,
      overdue: false,
      followUpId: null,
      store: null,
      taskId: null,
      laneId: null,
    });
  }

  for (const it of items) {
    it.urgencyRank =
      it.kind === "respond"
        ? URGENCY.respond
        : it.kind === "triage"
          ? URGENCY.triage
          : it.overdue
            ? URGENCY.overdue
            : it.dueAt && +new Date(it.dueAt) <= +todayEnd
              ? URGENCY.dueToday
              : URGENCY.upcoming;
  }

  items.sort((a, b) => {
    if (a.urgencyRank !== b.urgencyRank) return a.urgencyRank - b.urgencyRank;
    const ta = a.dueAt ? +new Date(a.dueAt) : Infinity;
    const tb = b.dueAt ? +new Date(b.dueAt) : Infinity;
    if (ta !== tb) return ta - tb;
    return (a.leadName || "").localeCompare(b.leadName || "");
  });

  const counts = { overdue: 0, respond: 0, dueToday: 0, triage: 0, upcoming: 0 };
  const keyByRank = ["overdue", "respond", "dueToday", "triage", "upcoming"];
  for (const it of items) counts[keyByRank[it.urgencyRank]] += 1;

  return { items, counts, canTriage, generatedAt: at };
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /my-work/schedule?from&to  (YYYY-MM-DD, IST days; default today..+6d)
// ─────────────────────────────────────────────────────────────────────────────
const parseIstDay = (s, fallback) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  if (!m) return fallback;
  return fromIstParts(+m[1], +m[2] - 1, +m[3], 0, 0);
};

const schedule = async (callerId, { from, to } = {}, at = new Date()) => {
  const todayStart = istDayStart(at);
  let rangeStart = parseIstDay(from, todayStart);
  let rangeEndStart = parseIstDay(to, new Date(+rangeStart + 6 * DAY_MS));
  if (+rangeEndStart < +rangeStart) rangeEndStart = rangeStart;
  if (+rangeEndStart - +rangeStart > (MAX_SCHEDULE_DAYS - 1) * DAY_MS) {
    rangeEndStart = new Date(+rangeStart + (MAX_SCHEDULE_DAYS - 1) * DAY_MS);
  }
  const rangeEnd = new Date(+rangeEndStart + DAY_MS - 1);

  const visibility = await currentVisibilityFilter();

  // NO snooze exclusion here — a parked lead's far-out follow-up IS its wake
  // commitment, and wake dates must appear on the schedule.
  const [cadenceLeads, journeyRows, taskRows, meetingRows] = await Promise.all([
    Enquiry.find(
      {
        $and: [
          {
            ...notLostFilter(),
            assignedTo: callerId,
            archivedAt: null,
            followUps: { $elemMatch: { scheduledAt: { $gte: rangeStart, $lte: rangeEnd } } },
          },
          visibility,
        ],
      },
      { name: 1, followUps: 1 }
    ).lean(),
    Followup.find(
      {
        ownerId: callerId,
        $or: [
          { dueAt: { $gte: rangeStart, $lte: rangeEnd } },
          { status: "snoozed", snoozedUntil: { $gte: rangeStart, $lte: rangeEnd } },
        ],
      },
      { leadId: 1, title: 1, dueAt: 1, status: 1, snoozedUntil: 1 }
    ).lean(),
    LeadTask.find(
      { assigneeId: callerId, dueAt: { $gte: rangeStart, $lte: rangeEnd } },
      { leadId: 1, title: 1, dueAt: 1, status: 1 }
    ).lean(),
    CalendarEvent.find(
      {
        type: { $in: ["gmeet", "meeting", "visit"] },
        status: { $ne: "cancelled" },
        start: { $gte: rangeStart, $lte: rangeEnd },
        $or: [
          { ownerId: callerId },
          { organizerAdminId: callerId },
          { participantIds: callerId },
          { "attendees.adminId": callerId },
        ],
      },
      { leadId: 1, title: 1, start: 1, status: 1 }
    ).lean(),
  ]);

  const refLeadIds = [
    ...new Set(
      [...journeyRows, ...taskRows, ...meetingRows].map((r) => String(r.leadId || "")).filter(Boolean)
    ),
  ];
  // Lost is terminal: the join carries only live leads, and every lead-anchored
  // item whose lead dropped out is skipped below.
  const refLeads = refLeadIds.length
    ? await Enquiry.find({ $and: [{ _id: { $in: refLeadIds } }, notLostFilter()] }, { name: 1 }).lean()
    : [];
  const leadName = new Map(refLeads.map((l) => [String(l._id), l.name]));

  const items = [];

  for (const lead of cadenceLeads) {
    for (const f of lead.followUps || []) {
      const t = f.scheduledAt ? +new Date(f.scheduledAt) : null;
      if (t == null || t < +rangeStart || t > +rangeEnd) continue;
      items.push({
        kind: "followup",
        store: "cadence",
        leadId: String(lead._id),
        leadName: lead.name,
        title: `${TYPE_LABEL[f.type] || "Follow-up"}${f.promiseNote ? ` — ${f.promiseNote}` : ""}`,
        at: f.scheduledAt,
        done: !!f.completedAt,
        followUpId: String(f._id),
        eventId: null,
        taskId: null,
      });
    }
  }

  for (const f of journeyRows) {
    if (!leadName.has(String(f.leadId))) continue; // lost/terminal lead
    // Effective date: a snoozed row lives at its snoozedUntil (its wake).
    const eff = f.status === "snoozed" && f.snoozedUntil ? f.snoozedUntil : f.dueAt;
    const t = eff ? +new Date(eff) : null;
    if (t == null || t < +rangeStart || t > +rangeEnd) continue;
    items.push({
      kind: "followup",
      store: "journey",
      leadId: String(f.leadId),
      leadName: leadName.get(String(f.leadId)) || "—",
      title: f.title,
      at: eff,
      done: f.status === "done",
      followUpId: String(f._id),
      eventId: null,
      taskId: null,
    });
  }

  for (const t of taskRows) {
    if (!leadName.has(String(t.leadId))) continue; // lost/terminal lead
    items.push({
      kind: "task",
      store: null,
      leadId: String(t.leadId),
      leadName: leadName.get(String(t.leadId)) || "—",
      title: t.title,
      at: t.dueAt,
      done: t.status === "done",
      followUpId: null,
      eventId: null,
      taskId: String(t._id),
    });
  }

  for (const e of meetingRows) {
    if (e.leadId && !leadName.has(String(e.leadId))) continue; // lost/terminal lead
    items.push({
      kind: "meeting",
      store: null,
      leadId: e.leadId ? String(e.leadId) : null,
      leadName: e.leadId ? leadName.get(String(e.leadId)) || "—" : null,
      title: e.title || "Meeting",
      at: e.start,
      done: e.status === "closed",
      followUpId: null,
      eventId: String(e._id),
      taskId: null,
    });
  }

  // Dense day array — every IST day in range, items sorted by time.
  const byDay = new Map();
  for (const it of items) {
    const key = istDayKey(it.at);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(it);
  }
  const days = [];
  for (let t = +rangeStart; t <= +rangeEndStart; t += DAY_MS) {
    const key = istDayKey(new Date(t));
    const dayItems = (byDay.get(key) || []).sort((a, b) => +new Date(a.at) - +new Date(b.at));
    const counts = {
      followup: dayItems.filter((i) => i.kind === "followup").length,
      meeting: dayItems.filter((i) => i.kind === "meeting").length,
      task: dayItems.filter((i) => i.kind === "task").length,
      total: dayItems.length,
    };
    days.push({ date: key, counts, items: dayItems });
  }

  // Overdue block — only when the range starts today or earlier.
  let overdue = null;
  if (+rangeStart <= +todayStart) {
    const snapshot = await now(callerId, at);
    const overdueItems = snapshot.items
      .filter((i) => i.urgencyRank === URGENCY.overdue)
      .map(({ kind, store, leadId, leadName: ln, title, dueAt, followUpId, taskId }) => ({
        kind, store, leadId, leadName: ln, title, at: dueAt, done: false, followUpId, eventId: null, taskId,
      }));
    overdue = { count: overdueItems.length, items: overdueItems };
  }

  return {
    from: istDayKey(rangeStart),
    to: istDayKey(rangeEndStart),
    days,
    overdue,
    generatedAt: at,
  };
};

module.exports = { now, schedule, ACTIVE, URGENCY };
