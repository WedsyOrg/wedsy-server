const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const Followup = require("../models/Followup");
const LeadLifecycleService = require("./LeadLifecycleService");
const WAConversationRepository = require("../repositories/WAConversationRepository");
const { computeLeadHealth } = require("../utils/leadHealth");
const {
  goldenWindowFor,
  goldenDeadline,
  istDayStart,
  istDayEnd,
  toIstWallClock,
} = require("../utils/goldenWindow");

// At-risk SLA defaults — runtime values come from SettingsService (atRisk.*).
const NEW_LEAD_SLA_HOURS = 24;
const CONTACTED_SILENCE_SLA_HOURS = 24;
const SettingsService = require("./SettingsService");
const { currentVisibilityFilter } = require("../utils/leadVisibility");
const RE_ENQUIRED_BADGE_DAYS = 7;

// A lead still in play for active dashboard surfaces.
const ACTIVE = {
  stage: { $nin: ["won", "lost"] },
  "recycled.isRecycled": { $ne: true },
  lostStatus: { $nin: ["pending", "approved"] },
};

// first 2 + last 4 of the local number visible, e.g. "+91 98••• •3210".
const maskPhone = (phone) => {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length < 7) return phone || "—";
  const local = digits.length > 10 ? digits.slice(-10) : digits;
  const cc = digits.length > 10 ? `+${digits.slice(0, digits.length - 10)} ` : "";
  return `${cc}${local.slice(0, 2)}••• •${local.slice(-4)}`;
};

const leadRow = (lead) => ({
  leadId: lead._id,
  name: lead.name,
  maskedPhone: maskPhone(lead.phone),
  stage: lead.stage,
  healthLabel: computeLeadHealth(lead, []).label,
});

// IST day key for sparkline bucketing.
const istDayKey = (d) => {
  const ist = toIstWallClock(new Date(d));
  return ist.toISOString().slice(0, 10);
};

const buildDashboard = async (adminId, scope, scopeFilter = {}) => {
  const now = new Date();
  const todayStart = istDayStart(now);
  const todayEnd = istDayEnd(now);
  const settings = await SettingsService.getMany([
    "atRisk.newHours",
    "atRisk.contactedHours",
    "golden.windowMinutes",
    "golden.workStartHour",
    "golden.workEndHour",
  ]);
  const newSlaHours = settings["atRisk.newHours"];
  const contactedSlaHours = settings["atRisk.contactedHours"];
  const goldenCfg = {
    windowMinutes: settings["golden.windowMinutes"],
    workStartHour: settings["golden.workStartHour"],
    workEndHour: settings["golden.workEndHour"],
  };
  const dayAgo = new Date(now.getTime() - newSlaHours * 3600 * 1000);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  // Lead visibility cutoff: mandatory listing filter on EVERY lead query below
  // ({} when the feature is off). Never applied to writes or direct fetches.
  const visibility = await currentVisibilityFilter();

  // Lazy resurface (Slice E): recycled leads past revisitAt come back before we read.
  await LeadLifecycleService.resurfaceDueLeads(scopeFilter);

  // MB5 Slice 4: lazy triage-escalation sweep rides the dashboard read too
  // (same no-new-infra pattern). No-op outside triage mode / working hours.
  try {
    await require("./TriageService").sweepEscalations();
  } catch (e) {
    console.error("[Dashboard] triage sweep failed:", e.message);
  }

  // MB5 Slice 5: Kiara safety net sweep — in-hours golden-window misses get
  // the welcome template. Template-gated; dormant when unset.
  try {
    await require("./KiaraSafetyNetService").sweepGoldenWindowMisses();
  } catch (e) {
    console.error("[Dashboard] safety net sweep failed:", e.message);
  }

  // MISSION-QUIET (Kiara): leads actively handled by the AI agent (mode ai,
  // open, not escalated) carry no call-now pressure — Kiara is already
  // talking to them. WhatsApp-source leads + safety-net-engaged leads (any
  // source, Slice 5). They re-enter missions the moment the conversation
  // escalates or qualifies (needsHuman flips / qualified path).
  let kiaraQuietIds = [];
  try {
    const quietConvIds = await WAConversationRepository.findQuietEnquiryIds();
    if (quietConvIds.length) {
      const quietLeads = await Enquiry.find(
        {
          _id: { $in: quietConvIds },
          $or: [{ source: "whatsapp" }, { kiaraSafetyNetAt: { $ne: null } }],
        },
        { _id: 1 }
      ).lean();
      kiaraQuietIds = quietLeads.map((l) => l._id);
    }
  } catch (e) {
    console.error("[Dashboard] kiara mission-quiet lookup failed:", e.message);
  }
  const kiaraQuiet = kiaraQuietIds.length ? { _id: { $nin: kiaraQuietIds } } : {};

  // Hardening: admins who can no longer work leads — their open leads are orphans.
  const inactiveAdminIds = (
    await Admin.find({ status: { $ne: "active" } }, { _id: 1 }).lean()
  ).map((a) => a._id);

  const [
    missionLeads,
    unresponsiveLeads,
    newUntouchedLeads,
    staleNewLeads,
    contactedLeads,
    hotLeadDocs,
    resurfacedDocs,
    promiseLeads,
    stageCounts,
    orphanedLeads,
    returnedLeadDocs,
    journeyFuDocs,
  ] = await Promise.all([
    // Open follow-ups due today or overdue.
    Enquiry.find({
      $and: [
        { ...scopeFilter, ...ACTIVE, followUps: { $elemMatch: { completedAt: null, scheduledAt: { $lte: todayEnd } } } },
        visibility,
      ],
    }).lean(),
    // Unresponsive — decide rows.
    Enquiry.find({ $and: [{ ...scopeFilter, ...ACTIVE, unresponsiveFlaggedAt: { $ne: null } }, visibility] }).lean(),
    // New & untouched (no call yet), oldest first. Kiara-quiet leads excluded —
    // the AI agent is mid-conversation with them.
    Enquiry.find({ $and: [{ ...scopeFilter, ...ACTIVE, ...kiaraQuiet, stage: "new", "callLog.0": { $exists: false } }, visibility] })
      .sort({ createdAt: 1 })
      .lean(),
    // At-risk A: New, no call, older than the SLA. Imported historical leads are
    // excluded — a Zoho migration must never read as an SLA storm. Kiara-quiet
    // leads excluded too (no call pressure while the agent is handling them).
    Enquiry.find({
      $and: [
        { ...scopeFilter, ...ACTIVE, ...kiaraQuiet, stage: "new", "callLog.0": { $exists: false }, createdAt: { $lt: dayAgo }, importedAt: null },
        visibility,
      ],
    }).lean(),
    // At-risk B candidates: Contacted (silence checked against the event stream below).
    Enquiry.find({ $and: [{ ...scopeFilter, ...ACTIVE, stage: "contacted" }, visibility] }).lean(),
    // Hot: meetings on the books.
    Enquiry.find({ $and: [{ ...scopeFilter, ...ACTIVE, stage: "meeting_scheduled" }, visibility] }).lean(),
    // Resurfaced today (isRecycled already cleared by the lazy pass).
    Enquiry.find({ $and: [{ ...scopeFilter, "recycled.resurfacedAt": { $gte: todayStart } }, visibility] }).lean(),
    // All open promises.
    Enquiry.find({
      $and: [
        { ...scopeFilter, ...ACTIVE, followUps: { $elemMatch: { completedAt: null, promiseNote: { $nin: [null, ""] } } } },
        visibility,
      ],
    }).lean(),
    // Pipeline weight per stage (recycled excluded; won/lost included for the funnel).
    Enquiry.aggregate([
      { $match: { $and: [{ ...scopeFilter, "recycled.isRecycled": { $ne: true } }, visibility] } },
      { $group: { _id: "$stage", count: { $sum: 1 } } },
    ]),
    // Hardening: open leads owned by a non-active admin — at risk regardless of recency.
    inactiveAdminIds.length
      ? Enquiry.find({ $and: [{ ...scopeFilter, ...ACTIVE, assignedTo: { $in: inactiveAdminIds } }, visibility] }).lean()
      : Promise.resolve([]),
    // Hardening: lost leads that came back (re-enquired in the last 14 days).
    Enquiry.find({
      $and: [
        { ...scopeFilter, stage: "lost", reEnquiredAt: { $gte: new Date(now.getTime() - 14 * 24 * 3600 * 1000) } },
        visibility,
      ],
    }).lean(),
    // Signal Matrix Slice 6 — JOURNEY follow-ups (the Followup collection, the
    // post-qual store) due today or overdue. Lead-scoped after the fact (below)
    // with the SAME scope + ACTIVE + visibility narrowing as missionLeads, so
    // both stores surface in the mission without merging them.
    Followup.find({
      dueAt: { $lte: todayEnd },
      $or: [{ status: "open" }, { status: "snoozed", snoozedUntil: { $lte: now } }],
    }).lean(),
  ]);

  // Today's mission rows: one per due/overdue follow-up, chronological.
  // Slice 6: BOTH follow-up stores, tagged — "cadence" (embedded pre-qual rows,
  // completed via PUT /enquiry/:id/follow-up/:fid/complete) and "journey"
  // (Followup collection, completed via PATCH /enquiry/:id/followups/:fid).
  const cadenceMission = missionLeads.flatMap((lead) =>
    (lead.followUps || [])
      .filter((f) => !f.completedAt && new Date(f.scheduledAt) <= todayEnd)
      .map((f) => ({
        ...leadRow(lead),
        followUpId: f._id,
        store: "cadence",
        type: f.type,
        scheduledAt: f.scheduledAt,
        promiseNote: f.promiseNote || "",
        overdue: new Date(f.scheduledAt) < now,
        meetingToday:
          ["meet", "visit"].includes(f.type) &&
          new Date(f.scheduledAt) >= todayStart &&
          new Date(f.scheduledAt) <= todayEnd,
      }))
  );
  let journeyMission = [];
  if (journeyFuDocs.length) {
    const fuLeadIds = [...new Set(journeyFuDocs.map((f) => String(f.leadId)))];
    const fuLeads = await Enquiry.find({
      $and: [{ _id: { $in: fuLeadIds } }, scopeFilter, ACTIVE, visibility],
    }).lean();
    const leadById = new Map(fuLeads.map((l) => [String(l._id), l]));
    journeyMission = journeyFuDocs
      .filter((f) => leadById.has(String(f.leadId)))
      .map((f) => ({
        ...leadRow(leadById.get(String(f.leadId))),
        followUpId: f._id,
        store: "journey",
        type: null,
        title: f.title,
        scheduledAt: f.dueAt,
        promiseNote: "",
        overdue: new Date(f.dueAt) < now,
        meetingToday: false,
      }));
  }
  const todaysMission = [...cadenceMission, ...journeyMission].sort(
    (a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt)
  );

  const unresponsiveDecide = unresponsiveLeads.map((lead) => ({
    ...leadRow(lead),
    flaggedAt: lead.unresponsiveFlaggedAt,
    attempts: (lead.callLog || []).filter((e) => ["busy", "unknown"].includes(e.outcome)).length,
  }));

  const newUntouched = newUntouchedLeads.map((lead) => {
    // Imported leads anchor the golden window on the IMPORT time, not the
    // (historical) createdAt — a 2024 Zoho lead isn't a breached 30-min window.
    const gw = goldenWindowFor(lead.importedAt || lead.createdAt, now, goldenCfg);
    return {
      ...leadRow(lead),
      source: lead.marketingSource || lead.source || "",
      createdAt: lead.createdAt,
      minutesSinceCreated: Math.floor((now - new Date(lead.createdAt)) / 60000),
      goldenWindow: gw,
      reEnquired: !!(lead.reEnquiredAt && new Date(lead.reEnquiredAt) >= weekAgo),
    };
  });

  // At-risk B: contacted leads silent (no internal event) past the SLA.
  const contactedIds = contactedLeads.map((l) => l._id);
  const lastEvents = contactedIds.length
    ? await LeadInternalEvent.aggregate([
        { $match: { leadId: { $in: contactedIds } } },
        { $group: { _id: "$leadId", last: { $max: "$createdAt" } } },
      ])
    : [];
  const lastEventByLead = new Map(lastEvents.map((e) => [String(e._id), e.last]));
  const orphanIds = new Set(orphanedLeads.map((l) => String(l._id)));
  const atRisk = [
    // Orphans first: an inactive owner is the most urgent risk, recency irrelevant.
    ...orphanedLeads.map((lead) => ({
      ...leadRow(lead),
      reason: "owner_inactive",
      hoursOverSla: Math.floor((now - new Date(lead.updatedAt)) / 3600000),
    })),
    ...[
      ...staleNewLeads
        .filter((lead) => !orphanIds.has(String(lead._id)))
        .map((lead) => ({
          ...leadRow(lead),
          reason: "new_no_call",
          hoursOverSla: Math.floor((now - new Date(lead.createdAt)) / 3600000 - NEW_LEAD_SLA_HOURS),
        })),
      ...contactedLeads
        .filter((lead) => !orphanIds.has(String(lead._id)))
        .map((lead) => {
          const last = lastEventByLead.get(String(lead._id)) || lead.updatedAt;
          const silentHours = (now - new Date(last)) / 3600000;
          return silentHours > contactedSlaHours
            ? {
                ...leadRow(lead),
                reason: "contacted_silent",
                hoursOverSla: Math.floor(silentHours - contactedSlaHours),
              }
            : null;
        })
        .filter(Boolean),
    ].sort((a, b) => b.hoursOverSla - a.hoursOverSla),
  ];

  const hotLeads = hotLeadDocs.map((lead) => {
    const nextMeeting = (lead.followUps || [])
      .filter((f) => !f.completedAt && ["meet", "visit"].includes(f.type) && new Date(f.scheduledAt) > now)
      .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt))[0];
    return { ...leadRow(lead), nextMeetingAt: nextMeeting ? nextMeeting.scheduledAt : null };
  });

  const resurfacedToday = resurfacedDocs.map((lead) => ({
    ...leadRow(lead),
    reason: lead.recycled ? lead.recycled.reason : "",
    recycledAt: lead.recycled ? lead.recycled.recycledAt : null,
  }));

  const promises = promiseLeads
    .flatMap((lead) =>
      (lead.followUps || [])
        .filter((f) => !f.completedAt && f.promiseNote)
        .map((f) => ({
          leadId: lead._id,
          name: lead.name,
          followUpId: f._id,
          promiseNote: f.promiseNote,
          scheduledAt: f.scheduledAt,
          due: new Date(f.scheduledAt) <= todayEnd,
          overdue: new Date(f.scheduledAt) < now,
        }))
    )
    .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));

  const counts = {};
  for (const c of stageCounts) counts[c._id || "unknown"] = c.count;

  // Kiara escalations: needsHuman conversations surface as mission cards for
  // the lead's owner ("WhatsApp: <name> needs you — <reason>"), same scope
  // rules as every other lead surface.
  let waNeedsHuman = [];
  try {
    const escalated = await WAConversationRepository.findNeedsHuman();
    const escalatedLeadIds = escalated.map((c) => c.enquiryId).filter(Boolean);
    if (escalatedLeadIds.length) {
      const inScope = await Enquiry.find({
        $and: [{ _id: { $in: escalatedLeadIds } }, scopeFilter, visibility],
      }).lean();
      const byId = new Map(inScope.map((l) => [String(l._id), l]));
      waNeedsHuman = escalated
        .filter((c) => c.enquiryId && byId.has(String(c.enquiryId)))
        .map((c) => {
          const lead = byId.get(String(c.enquiryId));
          return {
            conversationId: c._id,
            leadId: lead._id,
            name: lead.name,
            maskedPhone: maskPhone(lead.phone),
            stage: lead.stage,
            reason: c.needsHumanReason || "Needs a human",
            needsHumanAt: c.needsHumanAt,
            unreadCount: c.unreadCount || 0,
          };
        })
        .sort((a, b) => new Date(a.needsHumanAt || 0) - new Date(b.needsHumanAt || 0));
    }
  } catch (e) {
    console.error("[Dashboard] kiara needs-human lookup failed:", e.message);
  }

  // Mission progress: follow-ups completed today in scope ("X of Y done").
  const completedTodayDocs = await Enquiry.aggregate([
    { $match: { $and: [{ ...scopeFilter }, visibility] } },
    { $unwind: "$followUps" },
    { $match: { "followUps.completedAt": { $gte: todayStart, $lte: todayEnd } } },
    { $count: "n" },
  ]);
  const completedToday = completedTodayDocs.length ? completedTodayDocs[0].n : 0;

  // "Returned — they came back": lost leads that re-enquired in the last 14 days.
  const returnedLeads = returnedLeadDocs.map((lead) => ({
    ...leadRow(lead),
    reEnquiredAt: lead.reEnquiredAt,
    lostReason: lead.lostReason || "",
    stageBeforeLost: lead.stageBeforeLost || "",
  }));

  const payload = {
    completedToday,
    generatedAt: now,
    scope,
    todaysMission,
    unresponsiveDecide,
    waNeedsHuman,
    newUntouched,
    atRisk,
    hotLeads,
    resurfacedToday,
    returnedLeads,
    promises,
    counts,
  };

  // Manager sections only for broader-than-own scopes.
  if (["team", "department", "all"].includes(scope)) {
    Object.assign(payload, await buildManagerSections(adminId, scope, scopeFilter, { now, todayStart, todayEnd, weekAgo, goldenCfg, newSlaHours, visibility }));
  }
  return payload;
};

const buildManagerSections = async (adminId, scope, scopeFilter, { now, todayStart, todayEnd, weekAgo, goldenCfg = {}, newSlaHours = NEW_LEAD_SLA_HOURS, visibility = {} }) => {
  const { getSubordinateIds } = require("../middlewares/requirePermission");
  const caller = await Admin.findById(adminId).lean();

  let pool;
  if (scope === "team") {
    const subIds = await getSubordinateIds(adminId);
    pool = await Admin.find({ _id: { $in: [adminId, ...subIds] } }).lean();
  } else if (scope === "department" && caller && caller.departmentId) {
    pool = await Admin.find({ departmentId: caller.departmentId, status: "active" }).lean();
  } else {
    pool = await Admin.find({ status: "active" }).lean();
  }
  const poolIds = pool.map((a) => a._id);

  // One aggregate for everyone's 7-day activity sparklines.
  const activity = await LeadInternalEvent.aggregate([
    { $match: { actorId: { $in: poolIds }, createdAt: { $gte: weekAgo } } },
    { $group: { _id: { actor: "$actorId", day: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "Asia/Kolkata" } } }, n: { $sum: 1 } } },
  ]);
  const activityByActor = new Map();
  for (const a of activity) {
    const key = String(a._id.actor);
    if (!activityByActor.has(key)) activityByActor.set(key, {});
    activityByActor.get(key)[a._id.day] = a.n;
  }
  const last7Days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now.getTime() - (6 - i) * 24 * 3600 * 1000);
    return istDayKey(d);
  });

  const teamRollup = await Promise.all(
    pool.map(async (member) => {
      const own = { assignedTo: member._id };
      const [dueToday, overdue, untouched, atRiskCount] = await Promise.all([
        Enquiry.countDocuments({
          $and: [
            { ...own, ...ACTIVE, followUps: { $elemMatch: { completedAt: null, scheduledAt: { $gte: todayStart, $lte: todayEnd } } } },
            visibility,
          ],
        }),
        Enquiry.countDocuments({
          $and: [
            { ...own, ...ACTIVE, followUps: { $elemMatch: { completedAt: null, scheduledAt: { $lt: todayStart } } } },
            visibility,
          ],
        }),
        Enquiry.countDocuments({ $and: [{ ...own, ...ACTIVE, stage: "new", "callLog.0": { $exists: false } }, visibility] }),
        Enquiry.countDocuments({
          $and: [
            { ...own, ...ACTIVE, stage: "new", "callLog.0": { $exists: false }, createdAt: { $lt: new Date(now.getTime() - newSlaHours * 3600 * 1000) } },
            visibility,
          ],
        }),
      ]);
      const byDay = activityByActor.get(String(member._id)) || {};
      return {
        adminId: member._id,
        name: member.name,
        dueToday,
        overdue,
        untouched,
        atRisk: atRiskCount,
        sparkline: last7Days.map((day) => byDay[day] || 0),
      };
    })
  );

  // Approval queue — PR #26 shapes (pending disqualify requests in scope).
  const approvalDocs = await Enquiry.find({ $and: [{ ...scopeFilter, lostStatus: "pending" }, visibility] }).lean();
  const requesterIds = approvalDocs.map((l) => l.lostRequestedBy).filter(Boolean);
  const requesters = requesterIds.length
    ? await Admin.find({ _id: { $in: requesterIds } }, { name: 1 }).lean()
    : [];
  const requesterById = new Map(requesters.map((r) => [String(r._id), r.name]));
  const approvalQueue = approvalDocs.map((lead) => ({
    leadId: lead._id,
    name: lead.name,
    maskedPhone: maskPhone(lead.phone),
    stage: lead.stage,
    lostReason: lead.lostReason,
    lostNote: lead.lostNote,
    lostRequestedBy: lead.lostRequestedBy,
    lostRequestedByName: requesterById.get(String(lead.lostRequestedBy)) || "—",
    lostRequestedAt: lead.lostRequestedAt,
  }));

  // Recent team activity feed.
  const recentEvents = await LeadInternalEvent.find({ actorId: { $in: poolIds } })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();
  const eventLeadIds = [...new Set(recentEvents.map((e) => String(e.leadId)))];
  const eventLeads = await Enquiry.find({ _id: { $in: eventLeadIds } }, { name: 1 }).lean();
  const leadNameById = new Map(eventLeads.map((l) => [String(l._id), l.name]));
  const adminNameById = new Map(pool.map((a) => [String(a._id), a.name]));
  const recentTeamActivity = recentEvents.map((e) => ({
    _id: e._id,
    type: e.type,
    leadId: e.leadId,
    leadName: leadNameById.get(String(e.leadId)) || "—",
    actorName: adminNameById.get(String(e.actorId)) || "system",
    payload: e.payload || {},
    createdAt: e.createdAt,
  }));

  // Golden-window health this week. Imported historical leads excluded — the
  // migration must never read as a wall of breaches.
  const weekLeads = await Enquiry.find(
    { $and: [{ ...scopeFilter, createdAt: { $gte: weekAgo }, importedAt: null }, visibility] },
    { createdAt: 1, firstCalledAt: 1 }
  ).lean();
  let minutesSum = 0;
  let calledCount = 0;
  let breaches = 0;
  for (const lead of weekLeads) {
    const deadline = goldenDeadline(lead.createdAt, goldenCfg);
    if (lead.firstCalledAt) {
      minutesSum += (new Date(lead.firstCalledAt) - new Date(lead.createdAt)) / 60000;
      calledCount += 1;
      if (new Date(lead.firstCalledAt) > deadline) breaches += 1;
    } else if (now > deadline) {
      breaches += 1;
    }
  }
  const goldenWindowHealth = {
    weekLeadCount: weekLeads.length,
    avgFirstCallMinutes: calledCount ? Math.round(minutesSum / calledCount) : null,
    breaches,
  };

  return { teamRollup, approvalQueue, recentTeamActivity, goldenWindowHealth };
};

module.exports = { buildDashboard, maskPhone, ACTIVE };
