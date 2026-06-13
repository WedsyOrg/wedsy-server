const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const SettingsService = require("./SettingsService");
const { goldenWindowFor, istDayStart } = require("../utils/goldenWindow");

// MB6 Slice 10 — intern/presales metrics, DERIVED ONLY (no new write paths).
// Sources: Enquiry fields (createdAt, firstCalledAt, qualified, qualifiedBy,
// followUps) + journey events (assignment + follow-up bookings).

const periodStart = (period, now = new Date()) => {
  if (period === "week") return new Date(istDayStart(now).getTime() - 6 * 24 * 3600 * 1000);
  if (period === "month") return new Date(istDayStart(now).getTime() - 29 * 24 * 3600 * 1000);
  return istDayStart(now); // today
};

// Pool-role admins visible under the caller's lead scope.
const visibleInterns = async (scopeFilter = {}) => {
  const poolRoles = (await SettingsService.get("assignment.poolRoles")) || [];
  const roles = await Role.find({ name: { $in: poolRoles }, deletedAt: null }, { _id: 1 }).lean();
  const base = { roleId: { $in: roles.map((r) => r._id) }, status: "active" };
  if (scopeFilter && Object.keys(scopeFilter).length > 0) {
    const v = scopeFilter.assignedTo;
    const ids = v && v.$in ? v.$in : v ? [v] : [];
    base._id = { $in: ids };
  }
  return await Admin.find(base, { name: 1 }).lean();
};

const ASSIGN_EVENT_TYPES = ["auto_assigned", "triage_assigned", "triage_auto_assigned"];

const metricsFor = async (intern, from, now, goldenCfg) => {
  const internId = String(intern._id);

  // Leads received: assignment events targeting this intern in the period.
  const assignEvents = await LeadInternalEvent.find({
    type: { $in: ASSIGN_EVENT_TYPES },
    createdAt: { $gte: from },
    $or: [{ "payload.assignedTo": internId }, { "payload.to": internId }],
  })
    .sort({ createdAt: 1 })
    .lean();
  const receivedLeadIds = [...new Set(assignEvents.map((e) => String(e.leadId)))];
  const receivedLeads = receivedLeadIds.length
    ? await Enquiry.find(
        { _id: { $in: receivedLeadIds } },
        { createdAt: 1, firstCalledAt: 1, importedAt: 1 }
      ).lean()
    : [];

  // Contacted-in-window % + avg time-to-first-call (received leads only).
  let contactedInWindow = 0;
  let contacted = 0;
  let firstCallMsTotal = 0;
  for (const lead of receivedLeads) {
    if (!lead.firstCalledAt) continue;
    contacted++;
    firstCallMsTotal += new Date(lead.firstCalledAt) - new Date(lead.createdAt);
    const gw = goldenWindowFor(lead.createdAt, new Date(lead.firstCalledAt), goldenCfg);
    if (gw.inWindow) contactedInWindow++;
  }

  // Qualified leads they own OR were handed off from (permanent qualifiedBy
  // credit) — the lead must actually be qualified either way.
  const qualified = await Enquiry.countDocuments({
    $or: [{ qualifiedBy: intern._id }, { assignedTo: intern._id }],
    qualified: true,
    updatedAt: { $gte: from },
  });

  // Meets booked by this intern in the period (journey, actor-stamped).
  const meetsBooked = await LeadInternalEvent.countDocuments({
    type: "follow_up_scheduled",
    actorId: intern._id,
    "payload.followUpType": "meet",
    createdAt: { $gte: from },
  });

  // Incomplete discovery: their qualified/credited leads missing any of the
  // canonical 7 discovery fields.
  const discoveryLeads = await Enquiry.find(
    {
      $or: [{ qualifiedBy: intern._id }, { assignedTo: intern._id }],
      qualified: true,
    },
    { qualificationData: 1 }
  ).lean();
  const incompleteDiscovery = discoveryLeads.filter((l) => {
    const q = l.qualificationData || {};
    const filled = [
      q.groomName,
      q.brideName,
      q.weddingStyle,
      q.venueStatus,
      q.email,
      (q.servicesRequired || []).length > 0,
      q.budgetAmount != null || q.budgetNote,
    ].filter(Boolean).length;
    return filled < 7;
  }).length;

  // Meeting show-up rate: completed vs booked across their meet follow-ups in
  // the period (completions stamped on the lead's followUps array; the booking
  // counts via the journey above).
  const meetLeads = await Enquiry.find(
    {
      followUps: { $elemMatch: { type: "meet", createdBy: intern._id, createdAt: { $gte: from } } },
    },
    { followUps: 1 }
  ).lean();
  let meetsCompleted = 0;
  let meetsBookedOnLeads = 0;
  for (const lead of meetLeads) {
    for (const f of lead.followUps || []) {
      if (f.type !== "meet" || String(f.createdBy) !== internId) continue;
      if (new Date(f.createdAt) < from) continue;
      meetsBookedOnLeads++;
      if (f.completedAt) meetsCompleted++;
    }
  }

  return {
    adminId: intern._id,
    name: intern.name,
    leadsReceived: receivedLeadIds.length,
    contacted,
    contactedInWindowPct: contacted ? Math.round((contactedInWindow / contacted) * 100) : null,
    qualified,
    meetsBooked,
    incompleteDiscovery,
    avgFirstCallMinutes: contacted ? Math.round(firstCallMsTotal / contacted / 60000) : null,
    meetShowUpRatePct: meetsBookedOnLeads ? Math.round((meetsCompleted / meetsBookedOnLeads) * 100) : null,
  };
};

const internMetrics = async ({ period = "today" } = {}, scopeFilter = {}) => {
  if (!["today", "week", "month"].includes(period)) {
    throw Object.assign(new Error("period must be today|week|month"), { status: 400 });
  }
  const now = new Date();
  const from = periodStart(period, now);
  const cfg = await SettingsService.getMany([
    "golden.windowMinutes",
    "golden.workStartHour",
    "golden.workEndHour",
  ]);
  const goldenCfg = {
    windowMinutes: cfg["golden.windowMinutes"],
    workStartHour: cfg["golden.workStartHour"],
    workEndHour: cfg["golden.workEndHour"],
  };
  const interns = await visibleInterns(scopeFilter);
  const rows = [];
  for (const intern of interns) {
    rows.push(await metricsFor(intern, from, now, goldenCfg));
  }
  return { period, from, rows: rows.sort((a, b) => a.name.localeCompare(b.name)) };
};

module.exports = { internMetrics, visibleInterns, periodStart };
