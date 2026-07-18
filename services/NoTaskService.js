// C5 — THE NO-TASK RULE (the CS mock's core rule, applied to EVERY dept).
// An ACTIVE, OWNED lane with ZERO open lead-task and ZERO open follow-up
// attached to that lead BY THAT OWNER is a step nobody is actually driving.
// The state is COMPUTED (never stored beyond the EscalationMark): the episode
// anchor derives from real facts — the newest of lane.createdAt and the
// owner's latest completed task/follow-up on the lead — so adding a task ends
// the episode and completing it later starts a fresh one (new anchor → new
// mark key → one notification per episode, the EscalationMark pattern).
//   rung 1 (immediately)  → the lane owner
//   rung 2 (day 2+)       → the lead owner + Revenue Heads
// C4's content flags go to CS managers and are NOT this pass.
const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const LeadLane = require("../models/LeadLane");
const LeadTask = require("../models/LeadTask");
const Followup = require("../models/Followup");
const EscalationMark = require("../models/EscalationMark");
const AdminNotificationService = require("./AdminNotificationService");
const { filterAssignableIds } = require("../utils/assignable");

const DAY_MS = 24 * 60 * 60 * 1000;

const { notLostFilter } = require("../utils/lostTerminal");
const ACTIVE_LEAD = {
  ...notLostFilter(),
  stage: { $nin: ["won", "lost"] },
  "recycled.isRecycled": { $ne: true },
  archivedAt: null,
};

const ts = (v) => (v ? +new Date(v) : 0);

// ── The batched compute (shared with the CS dashboard's noTask surfaces) ─────
// lanes: lean LeadLane docs (need _id, leadId, ownerId, createdAt).
// Returns Map(String(laneId) → { noTask: bool, anchor: Date|null }).
// Exactly four queries for ANY number of lanes.
const computeNoTask = async (lanes = []) => {
  const out = new Map();
  const owned = (lanes || []).filter((l) => l && l.ownerId);
  for (const l of lanes || []) out.set(String(l._id), { noTask: false, anchor: null });
  if (!owned.length) return out;

  const leadIds = [...new Set(owned.map((l) => String(l.leadId)))];
  const ownerIds = [...new Set(owned.map((l) => String(l.ownerId)))];

  const [openTasks, doneTasks, openFus, doneFus, leads] = await Promise.all([
    LeadTask.find(
      { leadId: { $in: leadIds }, assigneeId: { $in: ownerIds }, status: "open" },
      { leadId: 1, assigneeId: 1 }
    ).lean(),
    LeadTask.find(
      { leadId: { $in: leadIds }, assigneeId: { $in: ownerIds }, status: "done", completedAt: { $ne: null } },
      { leadId: 1, assigneeId: 1, completedAt: 1 }
    ).lean(),
    Followup.find(
      { leadId: { $in: leadIds }, ownerId: { $in: ownerIds }, status: { $ne: "done" } },
      { leadId: 1, ownerId: 1 }
    ).lean(),
    Followup.find(
      { leadId: { $in: leadIds }, ownerId: { $in: ownerIds }, status: "done", completedAt: { $ne: null } },
      { leadId: 1, ownerId: 1, completedAt: 1 }
    ).lean(),
    // Embedded cadence follow-ups ride the lead doc (createdBy = the owner leg).
    Enquiry.find({ _id: { $in: leadIds } }, { followUps: 1 }).lean(),
  ]);

  const key = (leadId, adminId) => `${String(leadId)}:${String(adminId)}`;
  const hasOpen = new Set();
  const lastClosed = new Map(); // key → newest completedAt ms

  for (const t of openTasks) hasOpen.add(key(t.leadId, t.assigneeId));
  for (const f of openFus) hasOpen.add(key(f.leadId, f.ownerId));
  for (const t of doneTasks) {
    const k = key(t.leadId, t.assigneeId);
    if (ts(t.completedAt) > (lastClosed.get(k) || 0)) lastClosed.set(k, ts(t.completedAt));
  }
  for (const f of doneFus) {
    const k = key(f.leadId, f.ownerId);
    if (ts(f.completedAt) > (lastClosed.get(k) || 0)) lastClosed.set(k, ts(f.completedAt));
  }
  for (const lead of leads) {
    for (const f of lead.followUps || []) {
      if (!f.createdBy) continue;
      const k = key(lead._id, f.createdBy);
      if (!f.completedAt) hasOpen.add(k);
      else if (ts(f.completedAt) > (lastClosed.get(k) || 0)) lastClosed.set(k, ts(f.completedAt));
    }
  }

  for (const lane of owned) {
    const k = key(lane.leadId, lane.ownerId);
    if (hasOpen.has(k)) continue; // driven — not flagged
    const anchor = Math.max(ts(lane.createdAt), lastClosed.get(k) || 0);
    out.set(String(lane._id), { noTask: true, anchor: anchor ? new Date(anchor) : new Date() });
  }
  return out;
};

// Fire a rung once per episode (duplicate key ⇒ already notified).
const markOnce = async ({ leadId, laneId, rung, anchor }) => {
  try {
    await EscalationMark.create({
      key: `no_task:${leadId}:${laneId}:${rung}:${+anchor}`,
      leadId,
      kind: "no_task",
      rung,
    });
    return true;
  } catch (e) {
    if (e && e.code === 11000) return false;
    console.error("[NoTaskService] markOnce failed:", e.message);
    return false;
  }
};

// ── The daily pass (wired into the escalation sweep engine) ──────────────────
const sweepNoTask = async (now = new Date(), leadFilter = null) => {
  const lanes = await LeadLane.find(
    { state: "active", ownerId: { $ne: null }, key: { $ne: "lead_comms" } },
    { leadId: 1, ownerId: 1, name: 1, key: 1, createdAt: 1 }
  ).lean();
  if (!lanes.length) return { flagged: 0, rung1: 0, rung2: 0 };

  // Only lanes on still-in-play leads.
  const leadIds = [...new Set(lanes.map((l) => String(l.leadId)))];
  const liveLeads = await Enquiry.find(
    { $and: [{ _id: { $in: leadIds }, ...ACTIVE_LEAD }, leadFilter || {}] },
    { name: 1, assignedTo: 1 }
  ).lean();
  const leadById = new Map(liveLeads.map((l) => [String(l._id), l]));
  const liveLanes = lanes.filter((l) => leadById.has(String(l.leadId)));

  const flags = await computeNoTask(liveLanes);
  const { revenueHeadIds } = require("./TriageService");
  const rhIds = await revenueHeadIds();

  let flagged = 0, rung1 = 0, rung2 = 0;
  for (const lane of liveLanes) {
    const f = flags.get(String(lane._id));
    if (!f || !f.noTask) continue;
    flagged += 1;
    const lead = leadById.get(String(lane.leadId));

    // rung 1 — the lane owner, immediately.
    if (await markOnce({ leadId: lane.leadId, laneId: lane._id, rung: 1, anchor: f.anchor })) {
      const owner = await filterAssignableIds([lane.ownerId]);
      if (owner.length) {
        await AdminNotificationService.notify(owner, {
          type: "no_task",
          title: `Your step "${lane.name}" on ${lead.name} has no task — add one`,
          message: "An owned step with no open task or follow-up isn't moving. Add the next concrete action.",
          leadId: lane.leadId,
          payload: { laneId: String(lane._id), laneKey: lane.key, rung: 1 },
        });
        rung1 += 1;
      }
    }

    // rung 2 — day 2: the lead owner + Revenue Heads.
    if (+now - +new Date(f.anchor) >= 2 * DAY_MS) {
      if (await markOnce({ leadId: lane.leadId, laneId: lane._id, rung: 2, anchor: f.anchor })) {
        const recipients = new Set(rhIds.map(String));
        if (lead.assignedTo) recipients.add(String(lead.assignedTo));
        recipients.delete(String(lane.ownerId)); // they already got rung 1
        const live = await filterAssignableIds([...recipients]);
        if (live.length) {
          await AdminNotificationService.notify(live, {
            type: "no_task",
            title: `"${lane.name}" on ${lead.name} still has no task (day 2)`,
            message: `The step owner hasn't added a task or follow-up — worth a word.`,
            leadId: lane.leadId,
            payload: { laneId: String(lane._id), laneKey: lane.key, rung: 2 },
          });
          rung2 += 1;
        }
      }
    }
  }
  return { flagged, rung1, rung2 };
};

module.exports = { computeNoTask, sweepNoTask };
