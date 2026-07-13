// Slice A2 — THE SNOOZE ENGINE. The follow-up date is the single source of
// truth; nobody maintains a flag. A responded lead whose EARLIEST open
// follow-up (across BOTH stores — embedded cadence rows and the Followup
// collection) is more than snooze.thresholdDays out is "parked":
// snoozedUntil = that follow-up's date, snoozeSource = its _id. Every
// follow-up write recomputes: pull the date in → the lead wakes automatically;
// push it out → it re-snoozes. Unsnooze clears the fields without touching the
// follow-up (a manual override that lasts until the next follow-up write).
//
// While parked (snoozedUntil > now + wakeWarnDays) the lead leaves Respond
// Now, the dashboard missions, Rescue, and the deal-clock/lane-silence sweep.
// It STAYS in the leads list, lifecycle counts, and the work schedule (the
// wake date is a scheduled commitment). Inside the warn window it re-enters
// everything (pre-warming) and the owner gets ONE lead_waking nudge per
// episode (EscalationMark, anchor = the wake date). Past the date the daily
// sweep clears the fields (journey event lead_woken).
const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const Followup = require("../models/Followup");
const EscalationMark = require("../models/EscalationMark");
const SettingsService = require("./SettingsService");
const LeadInternalEventService = require("./LeadInternalEventService");
const AdminNotificationService = require("./AdminNotificationService");

const DAY_MS = 24 * 60 * 60 * 1000;
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v));
const httpError = (status, message) => Object.assign(new Error(message), { status });

const cfg = async () => {
  const s = await SettingsService.getMany(["snooze.thresholdDays", "snooze.wakeWarnDays"]);
  return { thresholdDays: s["snooze.thresholdDays"], wakeWarnDays: s["snooze.wakeWarnDays"] };
};

// Earliest OPEN follow-up across BOTH stores → { at: Date, source: ObjectId } | null.
// Journey rows: a per-followup snooze pushes its effective due to snoozedUntil.
const earliestOpenFollowUp = async (lead, now = new Date()) => {
  let best = null;
  for (const f of lead.followUps || []) {
    if (!f || f.completedAt || !f.scheduledAt) continue;
    const at = new Date(f.scheduledAt);
    if (Number.isNaN(+at)) continue;
    if (!best || at < best.at) best = { at, source: f._id };
  }
  const journey = await Followup.find(
    { leadId: lead._id, status: { $ne: "done" } },
    { dueAt: 1, status: 1, snoozedUntil: 1 }
  ).lean();
  for (const f of journey) {
    const at =
      f.status === "snoozed" && f.snoozedUntil && new Date(f.snoozedUntil) > now
        ? new Date(f.snoozedUntil)
        : new Date(f.dueAt);
    if (Number.isNaN(+at)) continue;
    if (!best || at < best.at) best = { at, source: f._id };
  }
  return best;
};

// Fire-safe journey event — a snooze bookkeeping failure must never break the
// follow-up write that triggered it.
const recordEvent = async (leadId, type, actorId, payload) => {
  try {
    await LeadInternalEventService.record({ leadId, type, actorId: actorId || null, payload: payload || {} });
  } catch (e) {
    console.error(`[Snooze] ${type} journey event failed:`, e.message);
  }
};

// THE recompute. Called (fire-safe) after every follow-up create/complete/
// reschedule in either store. Never throws.
const recompute = async (leadId, actorId = null) => {
  try {
    if (!isId(leadId)) return null;
    const lead = await Enquiry.findById(leadId, {
      snoozedUntil: 1, snoozeSource: 1, firstRespondedAt: 1, followUps: 1,
      stage: 1, isLost: 1, name: 1, assignedTo: 1,
    }).lean();
    if (!lead) return null;

    const now = new Date();
    const { thresholdDays } = await cfg();
    const earliest = await earliestOpenFollowUp(lead, now);
    const terminal = ["won", "lost"].includes(lead.stage) || lead.isLost;
    // NEVER snooze an unresponded lead — parking only applies once the client
    // has been reached and has asked for a later callback.
    const shouldSnooze =
      !terminal &&
      !!lead.firstRespondedAt &&
      !!earliest &&
      +earliest.at - +now > thresholdDays * DAY_MS;

    const nextUntil = shouldSnooze ? earliest.at : null;
    const nextSource = shouldSnooze ? earliest.source : null;
    const beforeMs = lead.snoozedUntil ? +new Date(lead.snoozedUntil) : null;
    const afterMs = nextUntil ? +nextUntil : null;

    if (beforeMs === afterMs && String(lead.snoozeSource || "") === String(nextSource || "")) {
      return { snoozedUntil: nextUntil, snoozeSource: nextSource, changed: false };
    }

    await Enquiry.updateOne(
      { _id: lead._id },
      { $set: { snoozedUntil: nextUntil, snoozeSource: nextSource } }
    );

    if (afterMs && !beforeMs) {
      await recordEvent(lead._id, "lead_snoozed", actorId, {
        until: nextUntil, source: String(nextSource || ""), thresholdDays,
      });
    } else if (!afterMs && beforeMs) {
      await recordEvent(lead._id, "lead_woken", actorId, { reason: "followup_change" });
    } else if (afterMs && beforeMs) {
      // Re-parked to a different date (episode moved) — log as a fresh snooze.
      await recordEvent(lead._id, "lead_snoozed", actorId, {
        until: nextUntil, source: String(nextSource || ""), moved: true, thresholdDays,
      });
    }
    return { snoozedUntil: nextUntil, snoozeSource: nextSource, changed: true };
  } catch (e) {
    console.error("[Snooze] recompute failed:", e.message);
    return null;
  }
};

// POST /enquiry/:_id/unsnooze — clears the park WITHOUT touching the follow-up.
// The override lasts until the next follow-up write recomputes.
const unsnooze = async (leadId, actorId) => {
  if (!isId(leadId)) throw httpError(400, "Invalid enquiry id");
  const lead = await Enquiry.findById(leadId, { snoozedUntil: 1, name: 1 }).lean();
  if (!lead) throw httpError(404, "Enquiry not found");
  if (!lead.snoozedUntil) return { snoozedUntil: null, snoozeSource: null, changed: false };
  await Enquiry.updateOne({ _id: leadId }, { $set: { snoozedUntil: null, snoozeSource: null } });
  await recordEvent(leadId, "lead_woken", actorId, { reason: "manual" });
  return { snoozedUntil: null, snoozeSource: null, changed: true };
};

// Query fragment every excluded consumer composes in (via $and — never spread,
// so it can't collide with an existing $or): drop leads still parked BEYOND the
// warn window. Inside the window the lead re-enters everything (pre-warming).
const snoozeExclusion = async (now = new Date()) => {
  const { wakeWarnDays } = await cfg();
  const warnCutoff = new Date(+now + wakeWarnDays * DAY_MS);
  return { $or: [{ snoozedUntil: null }, { snoozedUntil: { $lte: warnCutoff } }] };
};

// Single-lead GET decoration: null when not snoozed. FE contract:
// { until, note, waking } — note is the SOURCE follow-up's human text (cadence
// row: promiseNote or its type; journey row: its title), never an ObjectId.
const CADENCE_LABEL = { call: "Call", meet: "G-Meet", visit: "Visit" };
const decoration = async (lead, now = new Date()) => {
  try {
    if (!lead || !lead.snoozedUntil) return null;
    const { wakeWarnDays } = await cfg();
    let note = "";
    if (lead.snoozeSource) {
      const srcId = String(lead.snoozeSource);
      const cadence = (lead.followUps || []).find((f) => f && String(f._id) === srcId);
      if (cadence) {
        note = cadence.promiseNote || CADENCE_LABEL[cadence.type] || cadence.type || "";
      } else {
        const journey = await Followup.findById(srcId, { title: 1 }).lean();
        if (journey) note = journey.title || "";
      }
    }
    return {
      until: lead.snoozedUntil,
      note,
      waking: +new Date(lead.snoozedUntil) <= +now + wakeWarnDays * DAY_MS,
    };
  } catch (e) {
    return null;
  }
};

// ── The daily sweep leg (called from EscalationSweepService.runSweep) ────────
// 1. WARN: snoozedUntil within wakeWarnDays → notify the owner ONCE per episode
//    (EscalationMark; the episode anchor is the wake date itself, so a moved
//    date re-arms the nudge).
// 2. WAKE: snoozedUntil passed → clear the fields + journey event; the lead
//    naturally re-enters every queue.
const wakeSweep = async (now = new Date(), leadFilter = null) => {
  let warned = 0, woken = 0;
  try {
    const { wakeWarnDays } = await cfg();

    // WAKE first so a lead past its date never also warns.
    const due = await Enquiry.find(
      { $and: [{ snoozedUntil: { $ne: null, $lte: now } }, leadFilter || {}] },
      { name: 1, snoozedUntil: 1 }
    ).lean();
    for (const lead of due) {
      await Enquiry.updateOne({ _id: lead._id }, { $set: { snoozedUntil: null, snoozeSource: null } });
      await recordEvent(lead._id, "lead_woken", null, { reason: "wake_date_reached" });
      woken += 1;
    }

    if (wakeWarnDays > 0) {
      const warnCutoff = new Date(+now + wakeWarnDays * DAY_MS);
      const waking = await Enquiry.find(
        { $and: [{ snoozedUntil: { $gt: now, $lte: warnCutoff } }, leadFilter || {}] },
        { name: 1, assignedTo: 1, snoozedUntil: 1 }
      ).lean();
      for (const lead of waking) {
        if (!lead.assignedTo) continue;
        const sinceEpoch = +new Date(lead.snoozedUntil);
        const key = `snooze:${lead._id}:wake:1:${sinceEpoch}`;
        try {
          await EscalationMark.create({ key, leadId: lead._id, kind: "snooze", rung: 1 });
        } catch (e) {
          if (e && e.code === 11000) continue; // already warned this episode
          console.error("[Snooze] wake mark failed:", e.message);
          continue;
        }
        await AdminNotificationService.notify(lead.assignedTo, {
          type: "lead_waking",
          title: `${lead.name} is waking up`,
          message: `You promised ${lead.name} a callback on ${new Date(lead.snoozedUntil).toDateString()}`,
          leadId: lead._id,
          payload: { snoozedUntil: lead.snoozedUntil },
        });
        warned += 1;
      }
    }
  } catch (e) {
    console.error("[Snooze] wakeSweep failed:", e.message);
  }
  return { warned, woken };
};

module.exports = {
  recompute,
  unsnooze,
  snoozeExclusion,
  decoration,
  wakeSweep,
  earliestOpenFollowUp, // exported for tests
};
