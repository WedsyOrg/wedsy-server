const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const EnquiryRepository = require("../repositories/EnquiryRepository");
const GoldenWindowService = require("./GoldenWindowService");
const LeadInternalEventService = require("./LeadInternalEventService");
const AdminNotificationService = require("./AdminNotificationService");
const LeadTaskService = require("./LeadTaskService"); // idsByRoleName (Revenue Head)

const err = (status, message) => Object.assign(new Error(message), { status });
const isId = (v) => mongoose.Types.ObjectId.isValid(v);
const idStr = (v) => String(v);

// Per-lead tier-2 notify cooldown (in-memory, single-process) — same anti-spam
// pattern as the 8c-2a-ii nudge. Poll-bounded surfacing; not instant.
const TIER2_COOLDOWN_MS = 30 * 60 * 1000;
const lastTier2Notify = new Map();
// Speed-to-lead is a fresh-lead concern: only leads whose window opened within
// this horizon are live rescues (an uncontacted lead from weeks ago is a
// data-hygiene issue, not a rescue). Also bounds the all-scope scan.
const HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

// Leads dismissed from the rescue list (a manager handled it otherwise). Derived
// from journey events — no Enquiry field.
const dismissedSet = async (leadIds) => {
  if (!leadIds.length) return new Set();
  const rows = await LeadInternalEvent.find(
    { leadId: { $in: leadIds }, type: "rescue_dismissed" },
    { leadId: 1 }
  ).lean();
  return new Set(rows.map((r) => idStr(r.leadId)));
};

// SLICE 4 — the rescue queue for managers / the Revenue Head. Tier-2/3 leads
// (active, uncontacted, breach-imminent or breached) NOT owned by the caller:
//   • team scope → leads assigned to the caller's subordinates;
//   • all scope (Revenue Head) → every such lead.
// Own-scope callers get nothing (they rescue nobody; they're an assignee).
const rescueQueue = async (adminId, scope, now = new Date()) => {
  if (scope === "own" || !scope) return { rows: [], count: 0 };

  let leadFilter = {
    ...require("../utils/lostTerminal").notLostFilter(),
    firstCalledAt: null,
    qualified: { $ne: true },
    "recycled.isRecycled": { $ne: true },
    archivedAt: null,
    createdAt: { $gte: new Date(+now - HORIZON_MS) },
  };
  if (scope !== "all") {
    const subs = await GoldenWindowService.ownerScopeIds(adminId, scope); // [me, ...subs]
    const others = (subs || []).map(idStr).filter((id) => id !== idStr(adminId));
    if (!others.length) return { rows: [], count: 0 };
    leadFilter.assignedTo = { $in: others.map((id) => new mongoose.Types.ObjectId(id)) };
  }

  // Slice A2 — parked (snoozed) leads are not rescues: the client asked for a
  // later callback (e.g. responded on WhatsApp, so firstCalledAt can be null).
  const snoozeExcl = await require("./SnoozeService").snoozeExclusion(now);
  const leads = await Enquiry.find({ $and: [leadFilter, snoozeExcl] }, {
    name: 1, phone: 1, source: 1, marketingSource: 1, assignedTo: 1, createdAt: 1, firstCalledAt: 1, qualified: 1, isLost: 1, recycled: 1,
  }).lean();
  const t = await GoldenWindowService.thresholds();
  const hm = await GoldenWindowService.handoffMap(leads.map((l) => l._id));
  const dismissed = await dismissedSet(leads.map((l) => l._id));

  const candidates = [];
  for (const l of leads) {
    const c = GoldenWindowService.clockFor(l, hm.get(idStr(l._id)), t, now);
    if (c.tier >= 2 && !dismissed.has(idStr(l._id))) candidates.push({ lead: l, clock: c });
  }

  // Resolve assignee names (drop null owners BEFORE stringifying).
  const ownerIds = [...new Set(candidates.map((c) => c.lead.assignedTo).filter(Boolean).map(idStr))];
  const owners = ownerIds.length ? await Admin.find({ _id: { $in: ownerIds } }, { name: 1 }).lean() : [];
  const nameOf = new Map(owners.map((a) => [idStr(a._id), a.name]));

  const rows = candidates
    .map(({ lead, clock }) => ({
      _id: idStr(lead._id),
      name: lead.name,
      source: lead.source || lead.marketingSource || "",
      assignedTo: lead.assignedTo ? idStr(lead.assignedTo) : null,
      assigneeName: lead.assignedTo ? nameOf.get(idStr(lead.assignedTo)) || "—" : "—",
      deadlineAt: clock.deadlineAt,
      secondsLeft: clock.secondsLeft,
      breached: clock.breached, // tier-3 = the persistent breached ones
      tier: clock.breached ? 3 : 2,
      // Single derivable cause for this queue (uncontacted first-call golden
      // window, per the query predicate) — read off the already-computed clock.
      reason: clock.breached
        ? "No first response — golden window breached"
        : "Golden window closing — first response overdue",
      cause: clock.breached ? "first_call_breached" : "first_call_at_risk",
    }))
    .sort((a, b) => a.secondsLeft - b.secondsLeft);

  // Fire the tier-2 notification ONCE per lead (rate-limited) to the escalation
  // chain — the assignee's reporting manager + the Revenue Head(s).
  await notifyTier2(rows, leads, now);

  return { rows, count: rows.length };
};

const notifyTier2 = async (rows, leads, now) => {
  const leadById = new Map(leads.map((l) => [idStr(l._id), l]));
  let revHeads = null;
  for (const r of rows) {
    const prev = lastTier2Notify.get(r._id);
    if (prev && +now - prev < TIER2_COOLDOWN_MS) continue;
    const lead = leadById.get(r._id);
    const recipients = new Set();
    if (lead && lead.assignedTo) {
      const assignee = await Admin.findById(lead.assignedTo, { reportingManagerId: 1 }).lean();
      if (assignee && assignee.reportingManagerId) recipients.add(idStr(assignee.reportingManagerId));
    }
    if (revHeads === null) revHeads = (await LeadTaskService.idsByRoleName("Revenue Head")).map(idStr);
    revHeads.forEach((id) => recipients.add(id));
    const ids = [...recipients].filter(Boolean);
    if (ids.length) {
      await AdminNotificationService.notify(ids, {
        type: "rescue_needed",
        title: `Rescue needed: ${r.name}`,
        message: r.breached ? "Golden window breached — up for grabs." : "About to breach the golden window.",
        leadId: r._id,
        payload: { assigneeId: r.assignedTo },
      });
    }
    lastTier2Notify.set(r._id, +now);
  }
};

// CLAIM — atomic first-claim-wins. Reassigns the lead to the claimer ONLY if it
// is still owned by the breached assignee; a concurrent loser gets 409.
const claim = async (leadId, claimerId) => {
  if (!isId(leadId)) throw err(400, "Invalid leadId");
  const lead = await Enquiry.findById(leadId, { assignedTo: 1, name: 1 }).lean();
  if (!lead) throw err(404, "Lead not found");
  const expectedOwner = lead.assignedTo; // may be null
  if (expectedOwner && idStr(expectedOwner) === idStr(claimerId)) {
    // Already the claimer's — treat as a successful (idempotent) claim.
    return { claimed: true, alreadyMine: true, openCall: true, lead };
  }
  const updated = await EnquiryRepository.claimByReassign(leadId, expectedOwner, claimerId, claimerId);
  if (!updated) throw err(409, "Already claimed by someone else");

  await LeadInternalEventService.record({
    leadId, type: "transferred", actorId: claimerId,
    payload: { from: expectedOwner ? idStr(expectedOwner) : null, to: idStr(claimerId), reason: "rescue_claim" },
  });
  await LeadInternalEventService.record({
    leadId, type: "rescue_claimed", actorId: claimerId,
    payload: { breachedAssignee: expectedOwner ? idStr(expectedOwner) : null, rescuer: idStr(claimerId) },
  });
  return { claimed: true, openCall: true, lead: updated };
};

// Manager reassigns the rescue to a specific person (also atomic on the current owner).
const reassign = async (leadId, toAdminId, actorId) => {
  if (!isId(leadId) || !isId(toAdminId)) throw err(400, "Invalid id");
  const target = await Admin.findById(toAdminId, { status: 1 }).lean();
  if (!target || target.status !== "active") throw err(422, "Target admin is not active");
  const lead = await Enquiry.findById(leadId, { assignedTo: 1 }).lean();
  if (!lead) throw err(404, "Lead not found");
  const updated = await EnquiryRepository.claimByReassign(leadId, lead.assignedTo, toAdminId, actorId);
  if (!updated) throw err(409, "Already reassigned by someone else");
  await LeadInternalEventService.record({
    leadId, type: "transferred", actorId,
    payload: { from: lead.assignedTo ? idStr(lead.assignedTo) : null, to: idStr(toAdminId), reason: "rescue_reassign" },
  });
  return { reassigned: true, lead: updated };
};

// Dismiss the rescue item (handled otherwise) — a journey event; the queue
// excludes dismissed leads. No Enquiry field.
const dismiss = async (leadId, actorId) => {
  if (!isId(leadId)) throw err(400, "Invalid leadId");
  await LeadInternalEventService.record({ leadId, type: "rescue_dismissed", actorId, payload: {} });
  return { dismissed: true };
};

module.exports = { rescueQueue, claim, reassign, dismiss, TIER2_COOLDOWN_MS, _lastTier2Notify: lastTier2Notify };
