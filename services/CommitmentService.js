// Journey v2 (V8) — COMMITMENTS: everything someone promised to do on a lead,
// in one flat read — open tasks + open follow-ups from BOTH stores — plus the
// batched per-row due/overdue marks the lists render.
const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Followup = require("../models/Followup");
const LeadTask = require("../models/LeadTask");
const LeadLane = require("../models/LeadLane");
const { istDayStart, istDayEnd } = require("../utils/goldenWindow");

const httpError = (status, message) => Object.assign(new Error(message), { status });
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v));

const CADENCE_TITLE = { call: "Call", meet: "G-Meet", visit: "Visit" };

// The journey store's effective openness (a per-followup snooze re-opens when
// its snoozedUntil passes) — mirrors FollowupService.effective.
const journeyOpen = (f, now) =>
  f.status === "open" || (f.status === "snoozed" && (!f.snoozedUntil || +new Date(f.snoozedUntil) <= +now));

// GET /enquiry/:_id/commitments — flat, due-first (undated last).
const listCommitments = async (leadId) => {
  if (!isId(leadId)) throw httpError(400, "Invalid enquiry id");
  const now = new Date();
  const lead = await Enquiry.findById(leadId, { followUps: 1 }).lean();
  if (!lead) throw httpError(404, "Enquiry not found");

  const [journeyRows, tasks, lanes] = await Promise.all([
    Followup.find({ leadId, status: { $ne: "done" } }, {
      title: 1, dueAt: 1, ownerId: 1, status: 1, snoozedUntil: 1,
    }).lean(),
    LeadTask.find({ leadId, status: "open" }, {
      title: 1, dueAt: 1, assigneeId: 1, laneId: 1,
    }).lean(),
    LeadLane.find({ leadId }, { name: 1, key: 1 }).lean(),
  ]);
  const laneById = new Map(lanes.map((l) => [String(l._id), l]));

  const items = [];
  for (const f of lead.followUps || []) {
    if (!f || f.completedAt) continue;
    items.push({
      id: String(f._id),
      kind: "followup",
      store: "cadence",
      title: `${CADENCE_TITLE[f.type] || f.type}${f.promiseNote ? ` — ${f.promiseNote}` : ""}`,
      ownerId: f.createdBy ? String(f.createdBy) : null,
      dueAt: f.scheduledAt || null,
      laneId: null, laneName: null, laneKey: null,
    });
  }
  for (const f of journeyRows) {
    if (!journeyOpen(f, now)) continue;
    const due = f.status === "snoozed" && f.snoozedUntil && +new Date(f.snoozedUntil) > +now
      ? f.snoozedUntil
      : f.dueAt;
    items.push({
      id: String(f._id),
      kind: "followup",
      store: "journey",
      title: f.title,
      ownerId: f.ownerId ? String(f.ownerId) : null,
      dueAt: due || null,
      laneId: null, laneName: null, laneKey: null,
    });
  }
  for (const t of tasks) {
    const lane = t.laneId ? laneById.get(String(t.laneId)) : null;
    items.push({
      id: String(t._id),
      kind: "task",
      store: null,
      title: t.title,
      ownerId: t.assigneeId ? String(t.assigneeId) : null,
      dueAt: t.dueAt || null,
      laneId: lane ? String(t.laneId) : t.laneId ? String(t.laneId) : null,
      laneName: lane ? lane.name : null,
      laneKey: lane ? lane.key : null,
    });
  }

  // One batched name lookup.
  const ownerIds = [...new Set(items.map((i) => i.ownerId).filter(Boolean))];
  const owners = ownerIds.length
    ? await Admin.find({ _id: { $in: ownerIds } }, { name: 1 }).lean()
    : [];
  const nameOf = new Map(owners.map((a) => [String(a._id), a.name]));
  for (const i of items) {
    i.ownerName = i.ownerId ? nameOf.get(i.ownerId) || "—" : null;
    i.overdue = !!(i.dueAt && +new Date(i.dueAt) < +now);
  }

  // Due-first; undated commitments sink to the bottom.
  items.sort((a, b) => {
    if (!a.dueAt && !b.dueAt) return 0;
    if (!a.dueAt) return 1;
    if (!b.dueAt) return -1;
    return +new Date(a.dueAt) - +new Date(b.dueAt);
  });
  return items;
};

// Per-row dueToday/overdue marks for a PAGE of lead docs — EXACTLY two extra
// queries regardless of page size (embedded rows come from the docs already in
// memory). Scope: own-scope callers count ONLY their own commitments;
// manager+ scopes count every commitment on the (already scope-filtered) lead.
// Snoozed (parked) leads read zeros — their wake date is the only commitment.
const rowMarks = async (leadDocs, { scope, callerId } = {}) => {
  const now = new Date();
  const todayStart = istDayStart(now);
  const todayEnd = istDayEnd(now);
  const ownOnly = !scope || scope === "own";
  const callerStr = String(callerId || "");
  const leadIds = (leadDocs || []).map((l) => l._id);
  const marks = new Map(leadIds.map((id) => [String(id), { dueToday: 0, overdue: 0 }]));
  if (!leadIds.length) return marks;

  // Snoozed rows read zero marks; terminal-lost rows too (lost is terminal —
  // a lost lead's leftover follow-ups/tasks are not work).
  const { isTerminalLost } = require("../utils/lostTerminal");
  const snoozedSet = new Set(
    (leadDocs || [])
      .filter((l) => l.snoozedUntil || isTerminalLost(l))
      .map((l) => String(l._id))
  );
  const bump = (leadId, dueAt) => {
    const m = marks.get(String(leadId));
    if (!m || dueAt == null) return;
    const t = +new Date(dueAt);
    if (Number.isNaN(t)) return;
    if (t < +todayStart) m.overdue += 1;
    else if (t <= +todayEnd) m.dueToday += 1;
  };

  // Embedded cadence rows — zero queries (already on the docs).
  for (const lead of leadDocs || []) {
    if (snoozedSet.has(String(lead._id))) continue;
    for (const f of lead.followUps || []) {
      if (!f || f.completedAt || !f.scheduledAt) continue;
      if (ownOnly && String(f.createdBy || "") !== callerStr) continue;
      bump(lead._id, f.scheduledAt);
    }
  }

  // Journey rows + open tasks — ONE query each for the whole page.
  const [journeyRows, taskRows] = await Promise.all([
    Followup.find(
      {
        leadId: { $in: leadIds },
        dueAt: { $lte: todayEnd },
        $or: [{ status: "open" }, { status: "snoozed", snoozedUntil: { $lte: now } }],
        ...(ownOnly ? { ownerId: callerId } : {}),
      },
      { leadId: 1, dueAt: 1 }
    ).lean(),
    LeadTask.find(
      {
        leadId: { $in: leadIds },
        status: "open",
        dueAt: { $ne: null, $lte: todayEnd },
        ...(ownOnly ? { assigneeId: callerId } : {}),
      },
      { leadId: 1, dueAt: 1 }
    ).lean(),
  ]);
  for (const r of journeyRows) {
    if (snoozedSet.has(String(r.leadId))) continue;
    bump(r.leadId, r.dueAt);
  }
  for (const r of taskRows) {
    if (snoozedSet.has(String(r.leadId))) continue;
    bump(r.leadId, r.dueAt);
  }
  return marks;
};

module.exports = { listCommitments, rowMarks };
