const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const LeadLifecycleService = require("./LeadLifecycleService");
const { computeLeadHealth } = require("../utils/leadHealth");
const {
  goldenWindowFor,
  goldenDeadline,
  istDayStart,
  istDayEnd,
  toIstWallClock,
} = require("../utils/goldenWindow");

// At-risk SLAs — configurable via Settings later; constants for Phase 1.
const NEW_LEAD_SLA_HOURS = 24; // stage New with no call in 24h
const CONTACTED_SILENCE_SLA_HOURS = 24; // stage Contacted with no internal event in 24h
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
  const dayAgo = new Date(now.getTime() - NEW_LEAD_SLA_HOURS * 3600 * 1000);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);

  // Lazy resurface (Slice E): recycled leads past revisitAt come back before we read.
  await LeadLifecycleService.resurfaceDueLeads(scopeFilter);

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
  ] = await Promise.all([
    // Open follow-ups due today or overdue.
    Enquiry.find({
      ...scopeFilter,
      ...ACTIVE,
      followUps: { $elemMatch: { completedAt: null, scheduledAt: { $lte: todayEnd } } },
    }).lean(),
    // Unresponsive — decide rows.
    Enquiry.find({ ...scopeFilter, ...ACTIVE, unresponsiveFlaggedAt: { $ne: null } }).lean(),
    // New & untouched (no call yet), oldest first.
    Enquiry.find({ ...scopeFilter, ...ACTIVE, stage: "new", "callLog.0": { $exists: false } })
      .sort({ createdAt: 1 })
      .lean(),
    // At-risk A: New, no call, older than the SLA.
    Enquiry.find({
      ...scopeFilter,
      ...ACTIVE,
      stage: "new",
      "callLog.0": { $exists: false },
      createdAt: { $lt: dayAgo },
    }).lean(),
    // At-risk B candidates: Contacted (silence checked against the event stream below).
    Enquiry.find({ ...scopeFilter, ...ACTIVE, stage: "contacted" }).lean(),
    // Hot: meetings on the books.
    Enquiry.find({ ...scopeFilter, ...ACTIVE, stage: "meeting_scheduled" }).lean(),
    // Resurfaced today (isRecycled already cleared by the lazy pass).
    Enquiry.find({ ...scopeFilter, "recycled.resurfacedAt": { $gte: todayStart } }).lean(),
    // All open promises.
    Enquiry.find({
      ...scopeFilter,
      ...ACTIVE,
      followUps: { $elemMatch: { completedAt: null, promiseNote: { $nin: [null, ""] } } },
    }).lean(),
    // Pipeline weight per stage (recycled excluded; won/lost included for the funnel).
    Enquiry.aggregate([
      { $match: { ...scopeFilter, "recycled.isRecycled": { $ne: true } } },
      { $group: { _id: "$stage", count: { $sum: 1 } } },
    ]),
  ]);

  // Today's mission rows: one per due/overdue follow-up, chronological.
  const todaysMission = missionLeads
    .flatMap((lead) =>
      (lead.followUps || [])
        .filter((f) => !f.completedAt && new Date(f.scheduledAt) <= todayEnd)
        .map((f) => ({
          ...leadRow(lead),
          followUpId: f._id,
          type: f.type,
          scheduledAt: f.scheduledAt,
          promiseNote: f.promiseNote || "",
          overdue: new Date(f.scheduledAt) < now,
          meetingToday:
            ["meet", "visit"].includes(f.type) &&
            new Date(f.scheduledAt) >= todayStart &&
            new Date(f.scheduledAt) <= todayEnd,
        }))
    )
    .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));

  const unresponsiveDecide = unresponsiveLeads.map((lead) => ({
    ...leadRow(lead),
    flaggedAt: lead.unresponsiveFlaggedAt,
    attempts: (lead.callLog || []).filter((e) => ["busy", "unknown"].includes(e.outcome)).length,
  }));

  const newUntouched = newUntouchedLeads.map((lead) => {
    const gw = goldenWindowFor(lead.createdAt, now);
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
  const atRisk = [
    ...staleNewLeads.map((lead) => ({
      ...leadRow(lead),
      reason: "new_no_call",
      hoursOverSla: Math.floor((now - new Date(lead.createdAt)) / 3600000 - NEW_LEAD_SLA_HOURS),
    })),
    ...contactedLeads
      .map((lead) => {
        const last = lastEventByLead.get(String(lead._id)) || lead.updatedAt;
        const silentHours = (now - new Date(last)) / 3600000;
        return silentHours > CONTACTED_SILENCE_SLA_HOURS
          ? {
              ...leadRow(lead),
              reason: "contacted_silent",
              hoursOverSla: Math.floor(silentHours - CONTACTED_SILENCE_SLA_HOURS),
            }
          : null;
      })
      .filter(Boolean),
  ].sort((a, b) => b.hoursOverSla - a.hoursOverSla);

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

  const payload = {
    generatedAt: now,
    scope,
    todaysMission,
    unresponsiveDecide,
    newUntouched,
    atRisk,
    hotLeads,
    resurfacedToday,
    promises,
    counts,
  };

  // Manager sections only for broader-than-own scopes.
  if (["team", "department", "all"].includes(scope)) {
    Object.assign(payload, await buildManagerSections(adminId, scope, scopeFilter, { now, todayStart, todayEnd, weekAgo }));
  }
  return payload;
};

const buildManagerSections = async (adminId, scope, scopeFilter, { now, todayStart, todayEnd, weekAgo }) => {
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
          ...own,
          ...ACTIVE,
          followUps: { $elemMatch: { completedAt: null, scheduledAt: { $gte: todayStart, $lte: todayEnd } } },
        }),
        Enquiry.countDocuments({
          ...own,
          ...ACTIVE,
          followUps: { $elemMatch: { completedAt: null, scheduledAt: { $lt: todayStart } } },
        }),
        Enquiry.countDocuments({ ...own, ...ACTIVE, stage: "new", "callLog.0": { $exists: false } }),
        Enquiry.countDocuments({
          ...own,
          ...ACTIVE,
          stage: "new",
          "callLog.0": { $exists: false },
          createdAt: { $lt: new Date(now.getTime() - NEW_LEAD_SLA_HOURS * 3600 * 1000) },
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
  const approvalDocs = await Enquiry.find({ ...scopeFilter, lostStatus: "pending" }).lean();
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

  // Golden-window health this week.
  const weekLeads = await Enquiry.find(
    { ...scopeFilter, createdAt: { $gte: weekAgo } },
    { createdAt: 1, firstCalledAt: 1 }
  ).lean();
  let minutesSum = 0;
  let calledCount = 0;
  let breaches = 0;
  for (const lead of weekLeads) {
    const deadline = goldenDeadline(lead.createdAt);
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
