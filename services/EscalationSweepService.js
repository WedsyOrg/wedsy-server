// Slice B4 — THE ESCALATION SWEEP. One daily pass, three jobs:
//
//   1. LANE LADDER — ACTIVE lanes only (queued/paused/done exempt). Silence
//      (now − lastUpdateAt): ≥2d → the lane owner · ≥4d → the lead owner +
//      every Revenue Head · ≥6d → the Founders. An UNASSIGNED active lane is
//      rung-2 material immediately. Each rung fires ONCE per silence episode
//      (dedupe key carries the episode anchor = lastUpdateAt; a fresh update
//      moves the anchor and re-arms the ladder).
//   2. DEAL CLOCK — qualified, not-won/lost leads whose CURRENT spine station
//      is over its SLA (settings dealclock.*, same pattern as accountability.
//      staleDays): ladder = lead owner at SLA · +Revenue Heads at SLA+2d ·
//      +Founders at SLA+4d. A meeting past its scheduledAt and still unclosed
//      fires rung-1 immediately (anchor = scheduledAt, SLA 0).
//   3. WAKE PASS — queued lanes whose wake rule has come due (afterLane: that
//      lane is done; onDate: the date arrived) flip to active, get a
//      lane_woken auto entry, and their owner is notified.
//
// All notifications ride AdminNotificationService (itself fire-safe). `now`
// is injectable for tests; `opts.leadFilter` narrows every query (tests only).
const LeadLane = require("../models/LeadLane");
const LaneEntry = require("../models/LaneEntry");
const Enquiry = require("../models/Enquiry");
const EscalationMark = require("../models/EscalationMark");
const AdminNotificationService = require("./AdminNotificationService");
const DealSpineService = require("./DealSpineService");
const SettingsService = require("./SettingsService");
const TriageService = require("./TriageService");
const { idsByRoleName } = require("./LeadTaskService");

const DAY_MS = 24 * 60 * 60 * 1000;
const ts = (v) => (v ? +new Date(v) : null);

// Fire a rung once per episode: returns true if this call created the mark.
const markOnce = async ({ kind, leadId, slot, rung, sinceEpoch }) => {
  const key = `${kind}:${leadId}:${slot}:${rung}:${sinceEpoch}`;
  try {
    await EscalationMark.create({ key, leadId, kind, rung });
    return true;
  } catch (e) {
    if (e && e.code === 11000) return false; // already fired this episode
    console.error("[EscalationSweep] markOnce failed:", e.message);
    return false;
  }
};

const dayWord = (days) => `${days}d`;

// ── 1. Lane ladder ────────────────────────────────────────────────────────────
const sweepLanes = async (now, leadFilter, ctx) => {
  const lanes = await LeadLane.find({ state: "active" }).lean();
  const leadIds = [...new Set(lanes.map((l) => String(l.leadId)))];
  if (!leadIds.length) return 0;
  const leads = await Enquiry.find(
    { _id: { $in: leadIds }, stage: { $nin: ["won", "lost"] }, ...(leadFilter || {}) },
    { name: 1, assignedTo: 1 }
  ).lean();
  const leadById = new Map(leads.map((l) => [String(l._id), l]));

  let fired = 0;
  for (const lane of lanes) {
    const lead = leadById.get(String(lane.leadId));
    if (!lead) continue; // out of filter / terminal lead
    const sinceEpoch = ts(lane.lastUpdateAt) || 0;
    const silentDays = Math.floor((+now - sinceEpoch) / DAY_MS);
    const unassigned = !lane.ownerId;

    // rung → recipients (per the ladder spec).
    const rungs = [];
    if (!unassigned && silentDays >= 2) rungs.push({ rung: 1, to: [lane.ownerId] });
    if (silentDays >= 4 || unassigned) {
      rungs.push({ rung: 2, to: [lead.assignedTo, ...ctx.revenueHeads].filter(Boolean) });
    }
    if (silentDays >= 6) rungs.push({ rung: 3, to: ctx.founders });

    for (const r of rungs) {
      if (!r.to.length) continue;
      if (!(await markOnce({ kind: "lane", leadId: lane.leadId, slot: lane.key, rung: r.rung, sinceEpoch }))) continue;
      await AdminNotificationService.notify(r.to, {
        type: "lane_silent",
        title: `${lane.name} lane is silent — ${lead.name}`,
        message: unassigned && r.rung === 2
          ? `The ${lane.name} lane has NO owner. Assign someone.`
          : `No update for ${dayWord(silentDays)} in the ${lane.name} lane.`,
        leadId: lane.leadId,
        payload: { laneId: String(lane._id), laneKey: lane.key, rung: r.rung, silentDays },
      });
      fired += 1;
    }
  }
  return fired;
};

// ── 2. Deal clock ─────────────────────────────────────────────────────────────
const STATION_SLA_KEY = {
  meeting_set: "dealclock.qualifiedToMeetingDays",
  proposal: "dealclock.meetingHeldToProposalDays",
  agreement: "dealclock.proposalToAgreementDays",
  onboarded: "dealclock.agreementToOnboardedDays",
};

const sweepDealClock = async (now, leadFilter, ctx) => {
  const slas = await SettingsService.getMany(Object.values(STATION_SLA_KEY));
  const leads = await Enquiry.find(
    {
      qualified: true,
      stage: { $nin: ["won", "lost"] },
      "recycled.isRecycled": { $ne: true },
      lostStatus: { $nin: ["pending", "approved"] },
      ...(leadFilter || {}),
    },
    { name: 1, assignedTo: 1, qualified: 1, qualifiedAt: 1, stage: 1, followUps: 1, proposalSentAt: 1, isLost: 1, recycled: 1, createdAt: 1 }
  ).lean();

  let fired = 0;
  for (const lead of leads) {
    const spine = DealSpineService.computeDealSpine(lead, await DealSpineService.spineInputs(lead._id));
    if (!spine.current || spine.current === "qualified") continue;
    const idx = spine.stations.findIndex((s) => s.key === spine.current);

    // Anchor = nearest earlier done station's timestamp, else qualifiedAt.
    let anchor = null;
    for (let i = idx - 1; i >= 0; i--) {
      if (spine.stations[i].done && spine.stations[i].at) { anchor = ts(spine.stations[i].at); break; }
    }
    if (anchor == null) anchor = ts(lead.qualifiedAt);

    let slaMs;
    if (spine.current === "meeting_held") {
      // A meeting past its slot and still unclosed = immediately overdue.
      const meets = (lead.followUps || []).filter((f) => ["meet", "visit"].includes(f.type) && !f.completedAt && f.scheduledAt);
      const past = meets.map((f) => ts(f.scheduledAt)).filter((t) => t != null && t <= +now);
      if (!past.length) continue; // meeting still ahead — nothing owed
      anchor = Math.min(...past);
      slaMs = 0;
    } else {
      const key = STATION_SLA_KEY[spine.current];
      if (!key || anchor == null) continue;
      slaMs = Number(slas[key]) * DAY_MS;
    }

    const overMs = +now - anchor - slaMs;
    if (overMs < 0) continue;
    const overDays = Math.floor(overMs / DAY_MS);
    const rungs = [{ rung: 1, to: [lead.assignedTo].filter(Boolean) }];
    if (overDays >= 2) rungs.push({ rung: 2, to: [lead.assignedTo, ...ctx.revenueHeads].filter(Boolean) });
    if (overDays >= 4) rungs.push({ rung: 3, to: [lead.assignedTo, ...ctx.revenueHeads, ...ctx.founders].filter(Boolean) });

    const station = spine.stations[idx];
    for (const r of rungs) {
      if (!r.to.length) continue;
      if (!(await markOnce({ kind: "deal", leadId: lead._id, slot: spine.current, rung: r.rung, sinceEpoch: anchor }))) continue;
      await AdminNotificationService.notify(r.to, {
        type: "deal_stalled",
        title: `Deal stalled at ${station.label} — ${lead.name}`,
        message: slaMs === 0
          ? "The meeting time has passed with no outcome logged."
          : `${station.label} is ${dayWord(overDays)} over its SLA.`,
        leadId: lead._id,
        payload: { station: spine.current, rung: r.rung, overDays },
      });
      fired += 1;
    }
  }
  return fired;
};

// ── 3. Wake pass ──────────────────────────────────────────────────────────────
const sweepWake = async (now, leadFilter) => {
  const queued = await LeadLane.find({ state: "queued", "wake.type": { $in: ["afterLane", "onDate"] } }).lean();
  let woken = 0;
  for (const lane of queued) {
    if (leadFilter && !(await Enquiry.exists({ _id: lane.leadId, ...(leadFilter || {}) }))) continue;
    let due = false;
    if (lane.wake?.type === "onDate") {
      due = lane.wake.at && ts(lane.wake.at) <= +now;
    } else if (lane.wake?.type === "afterLane" && lane.wake.laneKey) {
      due = !!(await LeadLane.exists({ leadId: lane.leadId, key: lane.wake.laneKey, state: "done" }));
    }
    if (!due) continue;
    await LeadLane.updateOne(
      { _id: lane._id, state: "queued" },
      { $set: { state: "active", wake: null, lastUpdateAt: now } }
    );
    // Entry written directly (NOT autoEntryByLaneId — that would bump
    // lastUpdateAt past the sweep's `now` and blur the new episode anchor).
    await LaneEntry.create({
      laneId: lane._id,
      leadId: lane.leadId,
      kind: "auto",
      autoType: "lane_woken",
      text: "Lane woken — it's live now",
      authorId: null,
      at: now,
    }).catch((e) => console.error("[EscalationSweep] wake entry failed:", e.message));
    if (lane.ownerId) {
      await AdminNotificationService.notify(lane.ownerId, {
        type: "lane_woken",
        title: `Your ${lane.name} lane is live`,
        message: lane.wake?.type === "afterLane" ? `${lane.wake.laneKey} closed — you're up.` : "Its start date arrived.",
        leadId: lane.leadId,
        payload: { laneId: String(lane._id), laneKey: lane.key },
      });
    }
    woken += 1;
  }
  return woken;
};

// The daily pass. `now` injectable; `opts.leadFilter` narrows to seeded leads
// in tests (production runs unfiltered).
const runSweep = async (now = new Date(), opts = {}) => {
  const leadFilter = opts.leadFilter || null;
  const ctx = {
    revenueHeads: await TriageService.revenueHeadIds(),
    founders: await idsByRoleName("Founder"),
  };
  const laneSilent = await sweepLanes(now, leadFilter, ctx);
  const dealStalled = await sweepDealClock(now, leadFilter, ctx);
  const woken = await sweepWake(now, leadFilter);
  return { laneSilent, dealStalled, woken };
};

module.exports = { runSweep };
