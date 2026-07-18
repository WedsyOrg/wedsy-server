// C2 — THE CS DASHBOARD READ (GET /cs/dashboard). Locked-mock sections:
//   handoffs   — last 14d work handed TO the caller (task_assigned events +
//                lanes created under their ownership; lane re-assignment has
//                no durable per-assignee event — approximation noted).
//   todayStats — the caller's own commitments (both stores + tasks) + their
//                participant-lead count.
//   mySteps    — open lane ownerships + open tasks across leads, each lane
//                carrying the mock's no-task truth (NoTaskService).
//   awaiting   — the caller's lanes sitting in "Awaiting client".
//   workload   — member: own band; manager view: per-CS-member rollup.
//   leadsImOn  — compact participant leads with role + on_track/at_risk.
const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const LeadLane = require("../models/LeadLane");
const LeadTask = require("../models/LeadTask");
const Followup = require("../models/Followup");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const SettingsService = require("./SettingsService");
const NoTaskService = require("./NoTaskService");
const { participantLeadIds } = require("./ParticipantScopeService");
const { displayStatusOf } = require("./LeadLaneService");
const { istDayStart, istDayEnd } = require("../utils/goldenWindow");

const DAY_MS = 24 * 60 * 60 * 1000;
const HANDOFF_DAYS = 14;
const AT_RISK_SILENT_DAYS = 4; // the lanes' red silence threshold

const { notLostFilter } = require("../utils/lostTerminal");
const ACTIVE_LEAD = {
  ...notLostFilter(),
  stage: { $nin: ["won", "lost"] },
  "recycled.isRecycled": { $ne: true },
  archivedAt: null,
};

const LEAD_PROJ = { name: 1, assignedTo: 1, "qualificationData.eventDate": 1 };
const eventDateOf = (lead) => (lead && lead.qualificationData && lead.qualificationData.eventDate) || null;

const bands = async () => {
  const s = await SettingsService.getMany(["cs.capacity.hasRoom", "cs.capacity.balanced", "cs.capacity.nearFull"]);
  return {
    hasRoom: s["cs.capacity.hasRoom"],
    balanced: s["cs.capacity.balanced"],
    nearFull: s["cs.capacity.nearFull"],
  };
};
const bandOf = (open, b) =>
  open <= b.hasRoom ? "has_room" : open <= b.balanced ? "balanced" : open <= b.nearFull ? "near_full" : "overloaded";

const dashboard = async (callerId, ctx) => {
  const now = new Date();
  const todayStart = istDayStart(now);
  const todayEnd = istDayEnd(now);
  const since = new Date(+now - HANDOFF_DAYS * DAY_MS);
  const capacity = await bands();

  // ── caller-scoped raw material (batched) ──
  const [myLanes, myTasks, myFus, participantIds] = await Promise.all([
    LeadLane.find(
      { ownerId: callerId, state: { $in: ["active", "paused"] } },
      { leadId: 1, ownerId: 1, name: 1, key: 1, state: 1, pausedReason: 1, lastUpdateAt: 1, createdAt: 1 }
    ).lean(),
    LeadTask.find({ assigneeId: callerId, status: "open" }, { leadId: 1, laneId: 1, title: 1, dueAt: 1 }).lean(),
    Followup.find({ ownerId: callerId, status: { $ne: "done" } }, { leadId: 1, title: 1, dueAt: 1, status: 1, snoozedUntil: 1 }).lean(),
    participantLeadIds(callerId),
  ]);

  const liveLeads = participantIds.length
    ? await Enquiry.find({ _id: { $in: participantIds }, ...ACTIVE_LEAD }, LEAD_PROJ).lean()
    : [];
  const leadById = new Map(liveLeads.map((l) => [String(l._id), l]));
  const live = (leadId) => leadById.get(String(leadId)) || null;

  const liveLanes = myLanes.filter((l) => live(l.leadId));
  const noTaskMap = await NoTaskService.computeNoTask(liveLanes);

  // ── handoffs (task_assigned events + lanes assigned to me at creation) ──
  const taskEvents = await LeadInternalEvent.find(
    { type: "task_assigned", "payload.assigneeId": String(callerId), createdAt: { $gte: since } },
    { leadId: 1, actorId: 1, payload: 1, createdAt: 1 }
  ).lean();
  const recentLanes = liveLanes.filter((l) => +new Date(l.createdAt) >= +since);
  const actorIds = [...new Set(taskEvents.map((e) => String(e.actorId || "")).filter(Boolean))];
  const actors = actorIds.length ? await Admin.find({ _id: { $in: actorIds } }, { name: 1 }).lean() : [];
  const actorName = new Map(actors.map((a) => [String(a._id), a.name]));
  const handoffs = [
    ...taskEvents
      .filter((e) => live(e.leadId))
      .map((e) => ({
        leadId: String(e.leadId),
        leadName: live(e.leadId).name,
        what: `Task assigned — ${(e.payload || {}).title || "task"}`,
        byName: e.actorId ? actorName.get(String(e.actorId)) || "—" : "—",
        at: e.createdAt,
        eventDate: eventDateOf(live(e.leadId)),
      })),
    ...recentLanes.map((l) => ({
      leadId: String(l.leadId),
      leadName: live(l.leadId).name,
      what: `Lane assigned — ${l.name}`,
      byName: "—", // lane assignment carries no durable actor stamp
      at: l.createdAt,
      eventDate: eventDateOf(live(l.leadId)),
    })),
  ]
    .sort((a, b) => +new Date(b.at) - +new Date(a.at))
    .slice(0, 20);

  // ── todayStats (both stores + tasks; cadence rides my OWN leads) ──
  const openFu = (f) => !(f.status === "snoozed" && f.snoozedUntil && +new Date(f.snoozedUntil) > +now);
  const dueParts = { dueToday: 0, overdue: 0 };
  const bucket = (dueAt) => {
    if (!dueAt) return;
    const t = +new Date(dueAt);
    if (t < +todayStart) dueParts.overdue += 1;
    else if (t <= +todayEnd) dueParts.dueToday += 1;
  };
  for (const t of myTasks) if (live(t.leadId)) bucket(t.dueAt);
  for (const f of myFus) if (live(f.leadId) && openFu(f)) bucket(f.dueAt);
  // Cadence store rides the lead doc — fetched only for the leads I own.
  const ownedLeadIds = liveLeads.filter((l) => String(l.assignedTo || "") === String(callerId)).map((l) => l._id);
  if (ownedLeadIds.length) {
    const owned = await Enquiry.find({ _id: { $in: ownedLeadIds } }, { followUps: 1 }).lean();
    for (const l of owned) for (const f of l.followUps || []) if (!f.completedAt) bucket(f.scheduledAt);
  }
  const todayStats = { dueToday: dueParts.dueToday, overdue: dueParts.overdue, activeLeads: liveLeads.length };

  // ── mySteps (lane ownerships + task rows) ──
  const mySteps = [
    ...liveLanes.map((l) => ({
      kind: "lane",
      leadId: String(l.leadId),
      leadName: live(l.leadId).name,
      eventDate: eventDateOf(live(l.leadId)),
      stepName: l.name,
      laneId: String(l._id),
      displayStatus: displayStatusOf(l),
      dueAt: null,
      // Awaiting-client lanes are legitimately parked — only ACTIVE lanes flag.
      noTask: l.state === "active" && !!(noTaskMap.get(String(l._id)) || {}).noTask,
    })),
    ...myTasks
      .filter((t) => live(t.leadId))
      .map((t) => ({
        kind: "task",
        leadId: String(t.leadId),
        leadName: live(t.leadId).name,
        eventDate: eventDateOf(live(t.leadId)),
        stepName: t.title,
        laneId: t.laneId ? String(t.laneId) : null,
        displayStatus: "Task",
        dueAt: t.dueAt || null,
        noTask: false,
      })),
  ];

  // ── awaiting (my lanes in Awaiting client) ──
  const awaiting = liveLanes
    .filter((l) => displayStatusOf(l) === "Awaiting client")
    .map((l) => ({
      leadId: String(l.leadId),
      leadName: live(l.leadId).name,
      laneId: String(l._id),
      stepName: l.name,
      sinceAt: l.lastUpdateAt,
      waitingDays: Math.max(0, Math.floor((+now - +new Date(l.lastUpdateAt)) / DAY_MS)),
    }))
    .sort((a, b) => b.waitingDays - a.waitingDays);

  // ── leadsImOn (compact, with the at-risk read) ──
  const overdueLeadSet = new Set();
  for (const t of myTasks) if (t.dueAt && +new Date(t.dueAt) < +todayStart) overdueLeadSet.add(String(t.leadId));
  for (const f of myFus) if (openFu(f) && f.dueAt && +new Date(f.dueAt) < +todayStart) overdueLeadSet.add(String(f.leadId));
  const lanesByLead = new Map();
  for (const l of liveLanes) {
    const k = String(l.leadId);
    if (!lanesByLead.has(k)) lanesByLead.set(k, []);
    lanesByLead.get(k).push(l);
  }
  const leadsImOn = liveLeads.map((lead) => {
    const mine = lanesByLead.get(String(lead._id)) || [];
    const silent = mine.some((l) => l.state === "active" && +now - +new Date(l.lastUpdateAt) >= AT_RISK_SILENT_DAYS * DAY_MS);
    const myRole = mine.length
      ? mine.map((l) => l.name).join(", ")
      : String(lead.assignedTo || "") === String(callerId)
        ? "Lead owner"
        : "Team";
    return {
      leadId: String(lead._id),
      name: lead.name,
      eventDate: eventDateOf(lead),
      myRole,
      health: silent || overdueLeadSet.has(String(lead._id)) ? "at_risk" : "on_track",
    };
  });

  // ── workload ──
  let workload;
  if (!ctx.isManagerView) {
    workload = { open: liveLanes.length, capacityBand: bandOf(liveLanes.length, capacity) };
  } else {
    const memberIds = ctx.memberIds;
    const members = memberIds.length
      ? await Admin.find({ _id: { $in: memberIds } }, { name: 1 }).sort({ name: 1 }).lean()
      : [];
    const allLanes = memberIds.length
      ? await LeadLane.find(
          { ownerId: { $in: memberIds }, state: { $in: ["active", "paused"] } },
          { leadId: 1, ownerId: 1, createdAt: 1 }
        ).lean()
      : [];
    // Narrow to live leads once for the whole pool.
    const laneLeadIds = [...new Set(allLanes.map((l) => String(l.leadId)))];
    const laneLive = laneLeadIds.length
      ? await Enquiry.find({ _id: { $in: laneLeadIds }, ...ACTIVE_LEAD }, { _id: 1 }).lean()
      : [];
    const laneLiveSet = new Set(laneLive.map((l) => String(l._id)));
    const poolLanes = allLanes.filter((l) => laneLiveSet.has(String(l.leadId)));
    const poolNoTask = await NoTaskService.computeNoTask(poolLanes);
    const [taskDue, fuDue] = await Promise.all([
      LeadTask.aggregate([
        { $match: { assigneeId: { $in: memberIds }, status: "open", dueAt: { $gte: todayStart, $lte: todayEnd } } },
        { $group: { _id: "$assigneeId", n: { $sum: 1 } } },
      ]),
      Followup.aggregate([
        {
          $match: {
            ownerId: { $in: memberIds },
            dueAt: { $gte: todayStart, $lte: todayEnd },
            $or: [{ status: "open" }, { status: "snoozed", snoozedUntil: { $lte: now } }],
          },
        },
        { $group: { _id: "$ownerId", n: { $sum: 1 } } },
      ]),
    ]);
    const tMap = new Map(taskDue.map((r) => [String(r._id), r.n]));
    const fMap = new Map(fuDue.map((r) => [String(r._id), r.n]));
    const openByOwner = new Map();
    const noTaskByOwner = new Map();
    for (const l of poolLanes) {
      const k = String(l.ownerId);
      openByOwner.set(k, (openByOwner.get(k) || 0) + 1);
      if ((poolNoTask.get(String(l._id)) || {}).noTask) noTaskByOwner.set(k, (noTaskByOwner.get(k) || 0) + 1);
    }
    workload = members.map((m) => {
      const id = String(m._id);
      const open = openByOwner.get(id) || 0;
      return {
        adminId: id,
        name: m.name,
        open,
        dueToday: (tMap.get(id) || 0) + (fMap.get(id) || 0),
        noTaskCount: noTaskByOwner.get(id) || 0,
        capacityBand: bandOf(open, capacity),
      };
    });
  }

  return {
    view: ctx.isManagerView ? "manager" : "member",
    handoffs,
    todayStats,
    mySteps,
    awaiting,
    workload,
    leadsImOn,
    generatedAt: now,
  };
};

module.exports = { dashboard };
