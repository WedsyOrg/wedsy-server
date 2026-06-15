const mongoose = require("mongoose");
const Admin = require("../models/Admin");
const Enquiry = require("../models/Enquiry");
const { PHASES } = require("../models/StepDefinition");
const LeadStepRepository = require("../repositories/LeadStepRepository");
const LeadTeamMemberRepository = require("../repositories/LeadTeamMemberRepository");
const { getSubordinateIds, getDepartmentMemberIds } = require("../middlewares/requirePermission");

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
// STUCK rule (documented): a journey lead is "stuck" if it has any overdue step
// (a non-complete, non-N/A step whose dueAt is in the past) OR no step movement
// in STUCK_DAYS days (its most-recently-updated step is older than that).
const STUCK_DAYS = 5;

const idStr = (v) => String(v);

// The set of owner ids a caller's dashboard covers, by their (existing) lead
// scope — reused verbatim, no new gating:
//   own → just them · team → them + subordinates · department → dept members ·
//   all → null sentinel (unrestricted, i.e. the whole org's work).
const ownerScopeIds = async (adminId, scope) => {
  if (scope === "all") return null;
  if (scope === "team") return [adminId, ...(await getSubordinateIds(adminId))];
  if (scope === "department") {
    const admin = await Admin.findById(adminId, { departmentId: 1 }).lean();
    const members = await getDepartmentMemberIds(admin && admin.departmentId);
    return [...new Set([idStr(adminId), ...members.map(idStr)])].map((s) => new mongoose.Types.ObjectId(s));
  }
  return [adminId];
};

// Current journey phase of a lead from its steps: the phase of the first step
// (in order) not yet complete/N-A; "Completed" if all done; null if no steps.
const currentPhase = (steps) => {
  const open = steps.find((s) => s.status !== "complete" && !s.notApplicable);
  if (!steps.length) return null;
  return open ? open.phase || "—" : "Completed";
};

const isOverdueStep = (s, now) =>
  s.dueAt && new Date(s.dueAt) < now && s.status !== "complete" && !s.notApplicable;

// ── SLICE 1: MY WORK ─────────────────────────────────────────────────────────
const myWork = async (adminId, scope, { status, phase, overdueOnly, includeComplete } = {}) => {
  const now = new Date();
  const me = new mongoose.Types.ObjectId(adminId);
  const rosterLeadIds = await LeadTeamMemberRepository.findActiveLeadIdsByPerson(me);

  // The caller's candidate steps (server-computed, not raw-everything).
  let candidates;
  if (scope === "all") {
    candidates = await LeadStepRepository.findAllSteps();
  } else {
    const owners = await ownerScopeIds(adminId, scope);
    candidates = await LeadStepRepository.findByOwnerOrLead(owners, rosterLeadIds);
  }
  // N/A steps are not work.
  candidates = candidates.filter((s) => !s.notApplicable);

  // Full step sets of the involved leads → statuses for blocked + lead names.
  const leadIds = [...new Set(candidates.map((s) => idStr(s.leadId)))];
  const [fullSteps, leads] = await Promise.all([
    LeadStepRepository.findByLeadIds(leadIds.map((id) => new mongoose.Types.ObjectId(id))),
    Enquiry.find({ _id: { $in: leadIds } }, { name: 1, stage: 1 }).lean(),
  ]);
  const statusById = new Map(fullSteps.map((s) => [idStr(s._id), s.status]));
  const leadName = new Map(leads.map((l) => [idStr(l._id), l.name]));

  const decorate = (s) => {
    const unmet = (s.dependsOn || []).map(idStr).filter((d) => statusById.get(d) !== "complete");
    const overdue = isOverdueStep(s, now);
    const dueSoon = !overdue && s.dueAt && new Date(s.dueAt) >= now && new Date(s.dueAt) <= new Date(+now + WEEK);
    return {
      _id: idStr(s._id),
      leadId: idStr(s.leadId),
      leadName: leadName.get(idStr(s.leadId)) || "—",
      name: s.name,
      phase: s.phase || "",
      status: s.status,
      dueAt: s.dueAt || null,
      rolling: !!s.rolling,
      optional: !!s.optional,
      blocked: unmet.length > 0,
      overdue,
      dueSoon,
    };
  };
  const decorated = candidates.map(decorate);

  // Summary is computed over the actionable (non-complete) set, before UI filters.
  const actionable = decorated.filter((r) => r.status !== "complete");
  const counts = {
    total: actionable.length,
    overdue: actionable.filter((r) => r.overdue).length,
    dueThisWeek: actionable.filter((r) => r.dueSoon).length,
    blocked: actionable.filter((r) => r.blocked).length,
  };

  // UI filters.
  let rows = decorated;
  if (!includeComplete) rows = rows.filter((r) => r.status !== "complete");
  if (status) rows = rows.filter((r) => r.status === status);
  if (phase) rows = rows.filter((r) => r.phase === phase);
  if (overdueOnly) rows = rows.filter((r) => r.overdue);

  // DEFAULT SORT: overdue → due-soon → blocked → rest; then dueAt asc (nulls
  // last), then lead name.
  const rank = (r) => (r.overdue ? 0 : r.dueSoon ? 1 : r.blocked ? 2 : 3);
  rows.sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    const da = a.dueAt ? +new Date(a.dueAt) : Infinity;
    const db = b.dueAt ? +new Date(b.dueAt) : Infinity;
    if (da !== db) return da - db;
    return a.leadName.localeCompare(b.leadName);
  });

  return { rows, counts, scope };
};

// ── SLICE 2: PIPELINE OVERVIEW ───────────────────────────────────────────────
const pipelineOverview = async (adminId, scope, { phase, stuckOnly, memberId } = {}) => {
  const now = new Date();

  // Lead set: all-scope → all active leads; otherwise → leads the caller's scope
  // people are on the roster for (soft, MB8a-consistent — no new 403).
  let leads;
  if (scope === "all") {
    leads = await Enquiry.find(
      { isLost: { $ne: true }, "recycled.isRecycled": { $ne: true } },
      { name: 1, stage: 1, assignedTo: 1 }
    ).lean();
  } else {
    const owners = await ownerScopeIds(adminId, scope);
    const leadIds = await LeadTeamMemberRepository.findActiveLeadIdsByPersons(owners);
    leads = await Enquiry.find({ _id: { $in: leadIds } }, { name: 1, stage: 1, assignedTo: 1 }).lean();
  }

  const leadIds = leads.map((l) => l._id);
  const [allSteps, rosterRows] = await Promise.all([
    LeadStepRepository.findByLeadIds(leadIds),
    LeadTeamMemberRepository.findCurrentByLeadIds(leadIds),
  ]);

  const stepsByLead = new Map();
  for (const s of allSteps) {
    const k = idStr(s.leadId);
    if (!stepsByLead.has(k)) stepsByLead.set(k, []);
    stepsByLead.get(k).push(s);
  }
  const teamByLead = new Map();
  for (const r of rosterRows) {
    const k = idStr(r.leadId);
    if (!teamByLead.has(k)) teamByLead.set(k, []);
    teamByLead.get(k).push(idStr(r.personId));
  }

  // Resolve roster member names in one query.
  const memberIds = [...new Set(rosterRows.map((r) => idStr(r.personId)))];
  const members = memberIds.length ? await Admin.find({ _id: { $in: memberIds } }, { name: 1 }).lean() : [];
  const nameOf = new Map(members.map((a) => [idStr(a._id), a.name]));

  let rows = leads.map((l) => {
    const steps = (stepsByLead.get(idStr(l._id)) || []).sort((a, b) => (a.order || 0) - (b.order || 0));
    const phaseName = currentPhase(steps); // null when pre-journey
    const bucket = phaseName === null ? `Stage: ${l.stage || "new"}` : phaseName;

    // Progress within the current phase (complete + N/A counts as done).
    let progress = null;
    if (phaseName && phaseName !== "Completed") {
      const inPhase = steps.filter((s) => (s.phase || "—") === phaseName);
      const done = inPhase.filter((s) => s.status === "complete" || s.notApplicable).length;
      progress = { done, total: inPhase.length, phase: phaseName };
    } else if (phaseName === "Completed") {
      progress = { done: steps.length, total: steps.length, phase: "Completed" };
    }

    const overdue = steps.some((s) => isOverdueStep(s, now));
    const lastMove = steps.reduce((mx, s) => Math.max(mx, +new Date(s.updatedAt || 0)), 0);
    const noMovement = steps.length > 0 && lastMove > 0 && lastMove < +now - STUCK_DAYS * DAY;
    const stuck = steps.length > 0 && (overdue || noMovement);

    const team = (teamByLead.get(idStr(l._id)) || []).map((pid) => ({ _id: pid, name: nameOf.get(pid) || "—" }));
    return {
      _id: idStr(l._id),
      name: l.name,
      stage: l.stage || "new",
      assignedTo: l.assignedTo ? idStr(l.assignedTo) : null,
      bucket,
      hasJourney: steps.length > 0,
      progress,
      team,
      stuck,
      stuckReason: stuck ? (overdue ? "overdue step" : `no movement in ${STUCK_DAYS}d`) : null,
    };
  });

  // Filters.
  if (phase) rows = rows.filter((r) => r.bucket === phase);
  if (stuckOnly) rows = rows.filter((r) => r.stuck);
  if (memberId) rows = rows.filter((r) => r.assignedTo === String(memberId) || r.team.some((t) => t._id === String(memberId)));

  // Group by bucket, ordered: the 3 journey phases, Completed, then stage buckets.
  const order = [...PHASES, "Completed"];
  const groupsMap = new Map();
  for (const r of rows) {
    if (!groupsMap.has(r.bucket)) groupsMap.set(r.bucket, []);
    groupsMap.get(r.bucket).push(r);
  }
  const orderedKeys = [
    ...order.filter((k) => groupsMap.has(k)),
    ...[...groupsMap.keys()].filter((k) => !order.includes(k)).sort(),
  ];
  const groups = orderedKeys.map((bucket) => ({ bucket, count: groupsMap.get(bucket).length, leads: groupsMap.get(bucket) }));

  const summary = {
    totalLeads: rows.length,
    stuck: rows.filter((r) => r.stuck).length,
    byPhase: groups.map((g) => ({ phase: g.bucket, count: g.count })),
  };
  return { groups, summary, scope, stuckDays: STUCK_DAYS };
};

module.exports = { myWork, pipelineOverview, STUCK_DAYS };
