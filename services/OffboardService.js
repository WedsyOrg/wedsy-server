// Slice A3 — OFFBOARDING SWEEP. When an admin is disabled, their working set
// (open leads + lane ownerships + open lead-tasks) is moved in ONE founder
// action: mode "reassign" hands everything to a live admin (must pass the
// shared assignable predicate); mode "triage" un-assigns the leads into the
// triage queue. snoozedUntil is PRESERVED either way — a parked lead stays
// parked; the new owner inherits the wake date. Every touched lead gets a
// system note + journey event; every touched lane gets an owner_changed auto
// entry. Batched throughout: a fixed number of queries regardless of volume.
const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const LeadLane = require("../models/LeadLane");
const LaneEntry = require("../models/LaneEntry");
const LeadTask = require("../models/LeadTask");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const { isAssignableAdmin } = require("../utils/assignable");

const httpError = (status, message) => Object.assign(new Error(message), { status });
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v));

// Open = still workable: not won, not lost. (An approved-lost lead carries
// stage "lost", so the stage guard covers both spellings of gone.)
const OPEN_STAGE = { stage: { $nin: ["won", "lost"] } };

const noteStamp = () =>
  new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

const offboardLeads = async (sourceAdminId, { mode, targetAdminId } = {}, actorId) => {
  if (!isId(sourceAdminId)) throw httpError(400, "Invalid admin id");
  if (!["reassign", "triage"].includes(mode)) {
    throw httpError(400, 'mode must be "reassign" or "triage"');
  }
  const source = await Admin.findById(sourceAdminId).lean();
  if (!source) throw httpError(404, "Admin not found");
  // The sweep is for offboarding: the source must already be disabled, so a
  // typo'd id can never silently strip a live admin of their book.
  if (!source.isDisabled) throw httpError(409, "Admin is not disabled — disable them first");

  let target = null;
  if (mode === "reassign") {
    if (!isId(targetAdminId)) throw httpError(400, "targetAdminId is required for reassign");
    if (String(targetAdminId) === String(sourceAdminId)) {
      throw httpError(422, "Target admin cannot receive leads (inactive or disabled)");
    }
    if (!(await isAssignableAdmin(targetAdminId))) {
      throw httpError(422, "Target admin cannot receive leads (inactive or disabled)");
    }
    target = await Admin.findById(targetAdminId, { name: 1 }).lean();
  }

  const now = new Date();
  const stamp = noteStamp();

  // ── Leads (one fetch; one bulkWrite; one insertMany of journey events) ──────
  const leads = await Enquiry.find(
    { assignedTo: source._id, ...OPEN_STAGE },
    { name: 1, snoozedUntil: 1, "updates.notes": 1 }
  ).lean();

  const leadOps = [];
  const events = [];
  for (const lead of leads) {
    const snoozeBit = lead.snoozedUntil
      ? ` — client asked for a ${new Date(lead.snoozedUntil).toDateString()} callback`
      : "";
    const note = `[${stamp}] Reassigned from ${source.name} on offboarding${snoozeBit}`;
    const notes = lead.updates && lead.updates.notes ? `${lead.updates.notes}\n\n${note}` : note;
    const set =
      mode === "reassign"
        ? { assignedTo: target._id, "updates.notes": notes }
        : { assignedTo: null, triagePending: true, triageEnteredAt: now, "updates.notes": notes };
    // snoozedUntil / snoozeSource deliberately untouched — the park survives.
    leadOps.push({ updateOne: { filter: { _id: lead._id }, update: { $set: set } } });
    events.push({
      leadId: lead._id,
      type: "lead_offboarded",
      actorId: actorId || null,
      payload: {
        mode,
        from: String(source._id),
        fromName: source.name,
        to: target ? String(target._id) : null,
        toName: target ? target.name : null,
        snoozedUntil: lead.snoozedUntil || null,
      },
    });
  }
  if (leadOps.length) await Enquiry.bulkWrite(leadOps, { ordered: false });
  if (events.length) await LeadInternalEvent.insertMany(events, { ordered: false });

  // ── Lanes (live ownerships only; done lanes keep their history) ─────────────
  const lanes = await LeadLane.find(
    { ownerId: source._id, state: { $in: ["queued", "active", "paused"] } },
    { leadId: 1, name: 1 }
  ).lean();
  if (lanes.length) {
    await LeadLane.updateMany(
      { _id: { $in: lanes.map((l) => l._id) } },
      { $set: { ownerId: target ? target._id : null } }
    );
    await LaneEntry.insertMany(
      lanes.map((lane) => ({
        laneId: lane._id,
        leadId: lane.leadId,
        kind: "auto",
        autoType: "owner_changed",
        text: target
          ? `Lane handed to ${target.name} — ${source.name} offboarded`
          : `Lane owner removed — ${source.name} offboarded`,
        authorId: null,
        at: now,
      })),
      { ordered: false }
    );
  }

  // ── Open lead-tasks ──────────────────────────────────────────────────────────
  const taskResult = await LeadTask.updateMany(
    { assigneeId: source._id, status: "open" },
    { $set: { assigneeId: target ? target._id : null } }
  );

  // FE contract: `moved` = leads moved; lanes/tasks/mode/from/to are extras.
  return {
    moved: leadOps.length,
    lanes: lanes.length,
    tasks: taskResult.modifiedCount || 0,
    mode,
    from: String(source._id),
    to: target ? String(target._id) : null,
  };
};

// Disable-time triage counts for the FE prompt: the disabled admin's open book.
const openLeadCounts = async (adminId) => {
  const [total, snoozed] = await Promise.all([
    Enquiry.countDocuments({ assignedTo: adminId, ...OPEN_STAGE }),
    Enquiry.countDocuments({ assignedTo: adminId, ...OPEN_STAGE, snoozedUntil: { $ne: null } }),
  ]);
  return { active: total - snoozed, snoozed, total };
};

module.exports = { offboardLeads, openLeadCounts };
