const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const WAConversation = require("../models/WAConversation");
const SettingsService = require("./SettingsService");
const { getSubordinateIds, getDepartmentMemberIds } = require("../middlewares/requirePermission");

const err = (status, message) => Object.assign(new Error(message), { status });
const isId = (v) => mongoose.Types.ObjectId.isValid(v);
const MIN = 60 * 1000;
const idStr = (v) => String(v);

// The SLA thresholds (minutes). Single source — settings_sla.
const thresholds = async () => {
  const v = await SettingsService.getMany(["sla.goldenWindowMinutes", "sla.rescueTier1Minutes", "sla.rescueTier2Minutes"]);
  return {
    durationMin: Number(v["sla.goldenWindowMinutes"]) || 30,
    tier1Min: Number(v["sla.rescueTier1Minutes"]) || 5,
    tier2Min: Number(v["sla.rescueTier2Minutes"]) || 1,
  };
};

// The clock START = "human needed": the Kiara-handoff moment for a Kiara-handled
// lead (WAConversation.needsHumanAt), else lead creation. Batched: one query for
// all candidate leads' handoff timestamps (no per-lead lookup, no Enquiry field).
const handoffMap = async (leadIds) => {
  if (!leadIds.length) return new Map();
  const convos = await WAConversation.find(
    { enquiryId: { $in: leadIds }, needsHumanAt: { $ne: null } },
    { enquiryId: 1, needsHumanAt: 1 }
  ).lean();
  const m = new Map();
  for (const c of convos) {
    const k = idStr(c.enquiryId);
    // Earliest "needs a human" wins (the first time it needed a call).
    const t = +new Date(c.needsHumanAt);
    if (!m.has(k) || t < m.get(k)) m.set(k, t);
  }
  return m;
};

const isClosed = (lead) => lead.isLost || (lead.recycled && lead.recycled.isRecycled);

// PURE clock for one lead. firstHumanContactAt = firstCalledAt (the existing
// set-once first-call stamp — the cockpit/record-call signal).
const clockFor = (lead, handoffAt, t, now) => {
  const startMs = handoffAt || +new Date(lead.createdAt);
  const deadlineMs = startMs + t.durationMin * MIN;
  const contactedMs = lead.firstCalledAt ? +new Date(lead.firstCalledAt) : null;
  const nowMs = +now;
  const closed = isClosed(lead);

  let state; // in_window | breached | contacted | resolved
  if (contactedMs != null) state = "contacted";
  else if (lead.qualified || closed) state = "resolved";
  else state = nowMs > deadlineMs ? "breached" : "in_window";

  const inWindow = contactedMs != null && contactedMs <= deadlineMs;
  const breached = state === "breached" || (contactedMs != null && contactedMs > deadlineMs);
  const active = state === "in_window" || state === "breached"; // still needs a human
  const secondsLeft = Math.round((deadlineMs - nowMs) / 1000);

  // Rescue tier (only for active/uncontacted leads).
  let tier = 0;
  if (active) {
    if (state === "breached" || secondsLeft <= t.tier2Min * 60) tier = 2;
    else if (secondsLeft <= t.tier1Min * 60) tier = 1;
  }

  return {
    startAt: new Date(startMs).toISOString(),
    deadlineAt: new Date(deadlineMs).toISOString(),
    contactedAt: contactedMs ? new Date(contactedMs).toISOString() : null,
    durationMinutes: t.durationMin,
    state, active, inWindow, breached, secondsLeft, tier,
    fromKiara: !!handoffAt,
  };
};

// ── State-1 (ADDITIVE) — richer banner fields for the single-lead hero ONLY.
// PURE; does NOT touch the existing `clock` object. Computed off the same lead +
// base clock and merged into leadClock()'s return as NEW keys. respond-now and
// metrics never call this, so their outputs are byte-identical.
//
// respondedAt = the signal spine's firstRespondedAt (Signal Matrix Slice 5) —
// the set-once any-channel response stamp written by every response path (call,
// WhatsApp send/press, timestamped note; write paths in Slice 4, history
// backfilled). The banner and the respond-now queue now read the SAME field, so
// they can never disagree. Tasks/chat never stamp it (internal ≠ response); the
// timestampless updates.notes blob still only counts toward hasActivity.
const bannerFields = (lead, clock, now, journeyFollowups = []) => {
  try {
    const nowMs = +now;
    const deadlineMs = clock && clock.deadlineAt ? +new Date(clock.deadlineAt) : null;

    const respondedAtMs = lead.firstRespondedAt ? +new Date(lead.firstRespondedAt) : null;
    const responded = respondedAtMs != null;
    const respondedWithinWindow = responded && deadlineMs != null && respondedAtMs <= deadlineMs;

    // nextAction = earliest FUTURE, open follow-up across BOTH stores
    // (divergent-truth fix: embedded cadence rows AND journey Followup rows —
    // a lead whose only open step lives in the journey collection previously
    // showed no next action).
    const followUps = Array.isArray(lead.followUps) ? lead.followUps : [];
    let next = null;
    let nextMs = null;
    for (const f of followUps) {
      if (!f || !f.scheduledAt || f.completedAt) continue;
      const ms = +new Date(f.scheduledAt);
      if (Number.isNaN(ms) || ms <= nowMs) continue;
      if (nextMs == null || ms < nextMs) {
        nextMs = ms;
        next = { type: f.type, scheduledAt: new Date(ms).toISOString() };
      }
    }
    for (const f of journeyFollowups || []) {
      if (!f || f.status === "done" || !f.dueAt) continue;
      // A per-followup snooze pushes its effective due to snoozedUntil.
      const at = f.status === "snoozed" && f.snoozedUntil && +new Date(f.snoozedUntil) > nowMs
        ? f.snoozedUntil
        : f.dueAt;
      const ms = +new Date(at);
      if (Number.isNaN(ms) || ms <= nowMs) continue;
      if (nextMs == null || ms < nextMs) {
        nextMs = ms;
        next = { type: "journey", title: f.title || "", scheduledAt: new Date(ms).toISOString() };
      }
    }
    const nextAction = next;

    // Activity = the spine's lastActivityAt (calls, both follow-up stores,
    // tasks, notes, WhatsApp, chat) — same field the lifecycle buckets read.
    const hasActivity = lead.lastActivityAt != null;

    // Precedence: next_action_due > responded > no_activity. Separate from `state`.
    let bannerState;
    if (nextAction) bannerState = "next_action_due";
    else if (responded) bannerState = "responded";
    else bannerState = "no_activity";

    return {
      respondedAt: respondedAtMs != null ? new Date(respondedAtMs).toISOString() : null,
      responded,
      respondedWithinWindow,
      nextAction,
      hasActivity,
      bannerState,
    };
  } catch (e) {
    // Additive + non-fatal: on any failure the base clock is returned untouched.
    return {};
  }
};

// Single-lead clock (the pre-qual hero).
const leadClock = async (leadId) => {
  if (!isId(leadId)) throw err(400, "Invalid leadId");
  // Projection EXTENDED additively (spine fields + followUps) to feed the
  // banner fields. The existing clock fields are computed from the same base
  // fields and are unchanged.
  const lead = await Enquiry.findById(leadId, {
    createdAt: 1, firstCalledAt: 1, firstRespondedAt: 1, lastActivityAt: 1,
    qualified: 1, isLost: 1, recycled: 1, followUps: 1,
  }).lean();
  if (!lead) throw err(404, "Lead not found");
  const [t, hm, journeyRows] = await Promise.all([
    thresholds(),
    handoffMap([lead._id]),
    // Both follow-up stores feed the banner's nextAction (fire-safe: [] on error).
    require("../repositories/FollowupRepository").findByLead(leadId).catch(() => []),
  ]);
  const now = new Date();
  const clock = clockFor(lead, hm.get(idStr(lead._id)), t, now);
  // ADDITIVE: merge the new banner fields alongside the verbatim clock fields.
  return { ...clock, ...bannerFields(lead, clock, now, journeyRows) };
};

// SLICE 2 — the caller's "Respond now" queue: their UNRESPONDED, active (in-window
// or breached) leads, urgency-sorted (breached first, then least time left).
// Signal Matrix Slice 5: the exit signal is the ANY-CHANNEL firstRespondedAt
// (call, WhatsApp send/press, timestamped note) — a lead answered on WhatsApp
// leaves the queue even though a call is still owed (the cadence engine keeps
// nagging for it). firstCalledAt stays the clock's call-only TAT anchor.
const respondNow = async (adminId, now = new Date()) => {
  if (!isId(adminId)) throw err(400, "Invalid adminId");
  // Bound to recent leads — speed-to-lead is a fresh-lead concern (a window from
  // weeks ago is stale, not a live "respond now").
  const RESPOND_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;
  // Slice A2 — parked (snoozed) leads leave the queue. Structurally redundant
  // today (snoozing requires firstRespondedAt, this queue requires it null) but
  // explicit so a future rule change can't silently re-admit parked leads.
  const snoozeExcl = await require("./SnoozeService").snoozeExclusion(now);
  const leads = await Enquiry.find(
    {
      $and: [
        {
          assignedTo: adminId,
          firstRespondedAt: null,
          qualified: { $ne: true },
          isLost: { $ne: true },
          "recycled.isRecycled": { $ne: true },
          archivedAt: null,
          createdAt: { $gte: new Date(+now - RESPOND_HORIZON_MS) },
        },
        snoozeExcl,
      ],
    },
    { name: 1, phone: 1, source: 1, marketingSource: 1, createdAt: 1, firstCalledAt: 1, firstRespondedAt: 1, qualified: 1, isLost: 1, recycled: 1 }
  ).lean();
  const t = await thresholds();
  const hm = await handoffMap(leads.map((l) => l._id));
  const rows = leads
    .map((l) => ({ ...clockBrief(l, clockFor(l, hm.get(idStr(l._id)), t, now)) }))
    .filter((r) => r.active); // in-window or breached only
  rows.sort((a, b) => a.secondsLeft - b.secondsLeft); // most overdue (most negative) first
  return { rows, count: rows.length, thresholds: t };
};

const clockBrief = (lead, clock) => ({
  _id: idStr(lead._id),
  name: lead.name,
  source: lead.source || lead.marketingSource || "",
  startAt: clock.startAt,
  deadlineAt: clock.deadlineAt,
  secondsLeft: clock.secondsLeft,
  state: clock.state,
  active: clock.active,
  breached: clock.breached,
  tier: clock.tier,
});

// Owner-scope ids by the caller's existing lead scope (reused, no new RBAC).
const ownerScopeIds = async (adminId, scope) => {
  if (scope === "all") return null; // unrestricted
  if (scope === "team") return [adminId, ...(await getSubordinateIds(adminId))];
  if (scope === "department") {
    const admin = await Admin.findById(adminId, { departmentId: 1 }).lean();
    const members = await getDepartmentMemberIds(admin && admin.departmentId);
    return [...new Set([idStr(adminId), ...members.map(idStr)])];
  }
  return [adminId];
};

// SLICE 3 — golden-window metrics over a period (scope-aware). Feeds MB9b.
const metrics = async (adminId, scope, { periodDays = 7 } = {}, now = new Date()) => {
  const owners = await ownerScopeIds(adminId, scope);
  const since = new Date(+now - periodDays * 24 * 60 * MIN);
  const filter = { createdAt: { $gte: since }, isLost: { $ne: true }, "recycled.isRecycled": { $ne: true }, archivedAt: null };
  if (owners) filter.assignedTo = { $in: owners.map((o) => new mongoose.Types.ObjectId(idStr(o))) };
  const leads = await Enquiry.find(filter, { createdAt: 1, firstCalledAt: 1, qualified: 1, isLost: 1, recycled: 1 }).lean();
  const t = await thresholds();
  const hm = await handoffMap(leads.map((l) => l._id));

  let decided = 0, inWindow = 0, breaches = 0, respSum = 0, respN = 0;
  for (const l of leads) {
    const c = clockFor(l, hm.get(idStr(l._id)), t, now);
    const isDecided = c.contactedAt != null || c.state === "breached";
    if (!isDecided) continue; // still pending in-window — not yet counted
    decided += 1;
    if (c.inWindow) inWindow += 1;
    if (c.breached) breaches += 1;
    if (c.contactedAt) {
      respSum += (+new Date(c.contactedAt) - +new Date(c.startAt)) / MIN;
      respN += 1;
    }
  }
  return {
    periodDays,
    total: decided,
    inWindowPct: decided ? Math.round((inWindow / decided) * 100) : null,
    avgFirstResponseMinutes: respN ? Math.round(respSum / respN) : null,
    breachCount: breaches,
    scope,
  };
};

module.exports = { thresholds, handoffMap, clockFor, leadClock, respondNow, metrics, ownerScopeIds, isClosed };
