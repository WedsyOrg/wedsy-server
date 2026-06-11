const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const EnquiryRepository = require("../repositories/EnquiryRepository");
const EnquiryService = require("./EnquiryService");
const CallCockpitService = require("./CallCockpitService");
const LeadAssignmentService = require("./LeadAssignmentService");
const LeadInternalEventService = require("./LeadInternalEventService");

// Default recycle reasons. Runtime list comes from SettingsService ("recycle.reasons").
const RECYCLE_REASONS = [
  "wedding_next_year",
  "budget_mismatch_now",
  "venue_not_booked",
  "other",
];
const SettingsService = require("./SettingsService");
const COMPLETION_OUTCOMES = ["connected", "busy", "no_answer", "done"];

const httpError = (status, message) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

const assertValidId = (id, label = "enquiry id") => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw httpError(400, `Invalid ${label}`);
  }
};

// A lead still in play: not won/lost, not recycled, no pending/approved disqualify.
const isOpenLead = (lead) =>
  !["won", "lost"].includes(lead.stage) &&
  !(lead.recycled && lead.recycled.isRecycled) &&
  !["pending", "approved"].includes(lead.lostStatus);

// ── Recycle: the third terminal state ──────────────────────────────────────
const recycleLead = async (enquiryId, { reason, reasonNote, revisitAt } = {}, actorId) => {
  assertValidId(enquiryId);
  const recycleReasons = await SettingsService.get("recycle.reasons");
  if (!recycleReasons.includes(reason)) {
    throw httpError(400, `Invalid reason (expected one of: ${recycleReasons.join(", ")})`);
  }
  if (reasonNote !== undefined && typeof reasonNote !== "string") {
    throw httpError(400, "Invalid reasonNote");
  }
  const revisitDate = new Date(revisitAt);
  if (!revisitAt || Number.isNaN(revisitDate.getTime()) || revisitDate <= new Date()) {
    throw httpError(422, "revisitAt is required and must be in the future");
  }

  const lead = await EnquiryRepository.findById(enquiryId);
  if (!lead) throw httpError(404, "Enquiry not found");
  if (lead.recycled && lead.recycled.isRecycled) {
    throw httpError(400, "Lead is already recycled");
  }
  if (["won", "lost"].includes(lead.stage)) {
    throw httpError(400, "Cannot recycle a closed lead");
  }

  const updated = await EnquiryRepository.updateFieldsById(enquiryId, {
    "recycled.isRecycled": true,
    "recycled.reason": reason,
    "recycled.reasonNote": reasonNote || "",
    "recycled.revisitAt": revisitDate,
    "recycled.recycledBy": actorId || null,
    "recycled.recycledAt": new Date(),
    "recycled.originalOwnerId": lead.assignedTo || null,
    "recycled.resurfacedAt": null,
  });

  await LeadInternalEventService.record({
    leadId: enquiryId,
    type: "recycled",
    actorId,
    payload: { reason, reasonNote: reasonNote || "", revisitAt: revisitDate },
  });

  return updated;
};

// ── Lazy resurface (read-time, no cron) ─────────────────────────────────────
// Recycled leads whose revisitAt has passed come back to life: clear isRecycled,
// stamp resurfacedAt, reassign to the original owner (if still active) or through
// the assignment service. Idempotent — the atomic guard on isRecycled means
// concurrent dashboard loads can't double-resurface.
const resurfaceDueLeads = async (scopeFilter = {}) => {
  const now = new Date();
  const due = await Enquiry.find({
    ...scopeFilter,
    "recycled.isRecycled": true,
    "recycled.revisitAt": { $lte: now },
  }).lean();

  const resurfaced = [];
  for (const lead of due) {
    const flipped = await Enquiry.findOneAndUpdate(
      { _id: lead._id, "recycled.isRecycled": true },
      { $set: { "recycled.isRecycled": false, "recycled.resurfacedAt": now } },
      { new: true }
    );
    if (!flipped) continue; // someone else resurfaced it concurrently

    let reassignedTo = null;
    const originalOwner = lead.recycled.originalOwnerId
      ? await Admin.findById(lead.recycled.originalOwnerId).lean()
      : null;
    if (originalOwner && originalOwner.status === "active") {
      await Enquiry.findByIdAndUpdate(lead._id, {
        $set: { assignedTo: originalOwner._id },
      });
      reassignedTo = originalOwner._id;
    } else {
      const assignee = await LeadAssignmentService.assignLead(lead._id);
      reassignedTo = assignee ? assignee._id : null;
    }

    await LeadInternalEventService.record({
      leadId: lead._id,
      type: "resurfaced",
      actorId: null,
      payload: {
        originalOwnerId: lead.recycled.originalOwnerId
          ? String(lead.recycled.originalOwnerId)
          : null,
        reassignedTo: reassignedTo ? String(reassignedTo) : null,
      },
    });
    resurfaced.push(lead._id);
  }
  return resurfaced;
};

// ── Follow-up completion with the ZERO-ORPHAN gate ──────────────────────────
// Completing a follow-up on an OPEN lead must carry exactly one of:
// nextFollowUp / stageAdvance / requestDisqualify / recycle — otherwise 422.
// Sole bypass: this completion itself flags the lead unresponsive (MAX attempts),
// which puts it on the dashboard's "Unresponsive — decide" surface instead.
const completeFollowUp = async (enquiryId, followUpId, body = {}, actorId) => {
  assertValidId(enquiryId);
  assertValidId(followUpId, "follow-up id");
  const { outcome, notes, durationSeconds, nextFollowUp, stageAdvance, requestDisqualify, recycle } = body;

  if (!COMPLETION_OUTCOMES.includes(outcome)) {
    throw httpError(400, `Invalid outcome (expected one of: ${COMPLETION_OUTCOMES.join(", ")})`);
  }
  if (notes !== undefined && typeof notes !== "string") {
    throw httpError(400, "Invalid notes");
  }

  const lead = await EnquiryRepository.findById(enquiryId);
  if (!lead) throw httpError(404, "Enquiry not found");
  const followUp = lead.followUps.id(followUpId);
  if (!followUp) throw httpError(404, "Follow-up not found");
  if (followUp.completedAt) throw httpError(400, "Follow-up is already completed");

  const open = isOpenLead(lead);
  const isCallOutcome = followUp.type === "call" || ["busy", "no_answer"].includes(outcome);
  const callLogOutcome =
    outcome === "busy" ? "busy" : outcome === "no_answer" ? "unknown" : "";

  // Prospective unresponsive check: would THIS unanswered attempt hit MAX?
  const prospectiveLog = isCallOutcome && callLogOutcome
    ? [...lead.callLog.toObject(), { outcome: callLogOutcome, startedAt: new Date() }]
    : lead.callLog;
  const willFlagUnresponsive =
    CallCockpitService.cadenceFor(prospectiveLog).unresponsive && !lead.unresponsiveFlaggedAt;

  // stageAdvance is a COMPOSITE action: advancing to Meeting Scheduled must be
  // accompanied by a nextFollowUp of type meet/visit with a valid FUTURE
  // scheduledAt in the same payload — a meeting stage without a booked meeting
  // time is invalid (reviewed rule).
  const stageAdvancePresent = stageAdvance !== undefined && stageAdvance !== null && stageAdvance !== false;
  const nextActions = [
    ["nextFollowUp", nextFollowUp],
    ["stageAdvance", stageAdvance],
    ["requestDisqualify", requestDisqualify],
    ["recycle", recycle],
  ].filter(([, v]) => v !== undefined && v !== null && v !== false);
  // The stageAdvance+nextFollowUp pair counts as ONE next step.
  const effectiveActionCount =
    stageAdvancePresent && nextActions.some(([n]) => n === "nextFollowUp")
      ? nextActions.length - 1
      : nextActions.length;

  if (open) {
    if (effectiveActionCount !== 1 && !(effectiveActionCount === 0 && willFlagUnresponsive)) {
      throw httpError(
        422,
        "Every completed follow-up on an open lead must carry exactly one next step: nextFollowUp, stageAdvance, requestDisqualify, or recycle. A lead can never be left without a scheduled next action."
      );
    }
  } else if (nextActions.length > 0) {
    throw httpError(400, "This lead is closed — no next action can be scheduled on it");
  }

  // PRE-validate the chosen action BEFORE any write: a bad payload must fail the
  // whole request, never leave the follow-up marked completed with no next step.
  if (stageAdvancePresent) {
    if (stageAdvance !== "meeting_scheduled") {
      throw httpError(400, "stageAdvance only supports meeting_scheduled");
    }
    const nf = nextFollowUp;
    const d = new Date(nf && nf.scheduledAt);
    if (
      !nf ||
      !["meet", "visit"].includes(nf.type) ||
      !nf.scheduledAt ||
      Number.isNaN(d.getTime()) ||
      d <= new Date()
    ) {
      throw httpError(422, "Advancing to Meeting Scheduled requires booking the meeting time");
    }
  } else if (nextActions.length === 1) {
    const [name, value] = nextActions[0];
    if (name === "nextFollowUp") {
      const d = new Date(value && value.scheduledAt);
      if (!value || !["meet", "call", "visit"].includes(value.type) || !value.scheduledAt || Number.isNaN(d.getTime())) {
        throw httpError(400, "nextFollowUp needs a valid type (meet/call/visit) and scheduledAt");
      }
    } else if (name === "requestDisqualify") {
      if (!value || !EnquiryService.LOST_REASONS.includes(value.reason)) {
        throw httpError(400, "requestDisqualify needs a valid reason");
      }
      if (lead.lostStatus === "pending") {
        throw httpError(400, "A disqualification is already pending on this lead");
      }
    } else if (name === "recycle") {
      const d = new Date(value && value.revisitAt);
      const recycleReasons = await SettingsService.get("recycle.reasons");
      if (!value || !recycleReasons.includes(value.reason)) {
        throw httpError(400, `recycle needs a valid reason (${recycleReasons.join(", ")})`);
      }
      if (!value.revisitAt || Number.isNaN(d.getTime()) || d <= new Date()) {
        throw httpError(422, "recycle.revisitAt is required and must be in the future");
      }
    }
  }

  // 1. Mark the follow-up completed (positional update on the subdoc).
  await Enquiry.updateOne(
    { _id: enquiryId, "followUps._id": followUpId },
    {
      $set: {
        "followUps.$.completedAt": new Date(),
        "followUps.$.completedBy": actorId || null,
        "followUps.$.completedOutcome": outcome,
        "followUps.$.completedNotes": notes || "",
      },
    }
  );

  // 2. A call-shaped completion appends to the append-only call log (which also
  //    runs the cadence/unresponsive logic inside logCall).
  let cadence = null;
  if (isCallOutcome) {
    const logged = await CallCockpitService.logCall(
      enquiryId,
      {
        startedAt: new Date().toISOString(),
        durationSeconds: Number(durationSeconds) || 0,
        connected: outcome === "connected" || outcome === "done",
        outcome: callLogOutcome,
        notes: notes || "",
      },
      actorId
    );
    cadence = logged.cadence || null;
  }

  // 3. Apply the chosen next action through the existing flows.
  let appliedAction = willFlagUnresponsive && nextActions.length === 0 ? "unresponsive_flagged" : null;
  if (stageAdvancePresent) {
    // Composite: book the meeting first, then advance the stage.
    appliedAction = "stageAdvance";
    await CallCockpitService.addFollowUp(enquiryId, nextFollowUp, actorId);
    await EnquiryService.updateStage(enquiryId, "meeting_scheduled", actorId);
  } else if (nextActions.length === 1) {
    const [name, value] = nextActions[0];
    appliedAction = name;
    if (name === "nextFollowUp") {
      await CallCockpitService.addFollowUp(enquiryId, value, actorId);
    } else if (name === "requestDisqualify") {
      await EnquiryService.requestDisqualification(
        enquiryId,
        { reason: value.reason, note: value.note },
        actorId
      );
    } else if (name === "recycle") {
      await recycleLead(enquiryId, value, actorId);
    }
  }

  await LeadInternalEventService.record({
    leadId: enquiryId,
    type: "follow_up_completed",
    actorId,
    payload: { followUpId: String(followUpId), outcome, nextAction: appliedAction },
  });

  const fresh = await EnquiryRepository.findById(enquiryId);
  const obj = fresh.toObject();
  if (cadence) obj.cadence = cadence;
  obj.appliedAction = appliedAction;
  return obj;
};

// ── Tags (Settings Suite, Slice 7a) ─────────────────────────────────────────
// Replace the lead's tag set. Every tag must come from the Settings library
// (tags.available) — free-text additions happen only on the settings page.
const setTags = async (enquiryId, tags, actorId) => {
  assertValidId(enquiryId);
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string")) {
    throw httpError(400, "tags must be an array of strings");
  }
  const library = await SettingsService.get("tags.available");
  const unknown = tags.filter((t) => !library.includes(t));
  if (unknown.length) {
    throw httpError(400, `Unknown tag(s): ${unknown.join(", ")} — add them to the library in Settings first`);
  }
  const lead = await EnquiryRepository.findById(enquiryId);
  if (!lead) throw httpError(404, "Enquiry not found");
  const before = lead.tags || [];
  const next = [...new Set(tags)];
  const updated = await EnquiryRepository.updateFieldsById(enquiryId, { tags: next });
  const added = next.filter((t) => !before.includes(t));
  const removed = before.filter((t) => !next.includes(t));
  if (added.length || removed.length) {
    await LeadInternalEventService.record({
      leadId: enquiryId,
      type: "tags_changed",
      actorId,
      payload: { added, removed, tags: next },
    });
  }
  return updated;
};

// ── Bulk transfer (Settings Suite, Slice 7b) ────────────────────────────────
// Scope is verified PER DOCUMENT: every lead must match the caller's scope filter
// or the WHOLE batch is rejected (403) listing the out-of-scope ids.
const bulkTransfer = async ({ leadIds, toAdminId } = {}, actorId, scopeFilter = {}) => {
  if (!Array.isArray(leadIds) || leadIds.length === 0) {
    throw httpError(400, "leadIds must be a non-empty array");
  }
  if (leadIds.length > 200) throw httpError(400, "Max 200 leads per transfer");
  for (const id of leadIds) assertValidId(id, "lead id");
  if (!mongoose.Types.ObjectId.isValid(toAdminId)) throw httpError(400, "Invalid toAdminId");

  const target = await Admin.findById(toAdminId).lean();
  if (!target) throw httpError(400, "Target admin not found");
  if (target.status !== "active") throw httpError(422, "Target admin is not active");

  const inScope = await Enquiry.find(
    { $and: [{ _id: { $in: leadIds } }, scopeFilter] },
    { _id: 1, assignedTo: 1 }
  ).lean();
  const inScopeIds = new Set(inScope.map((l) => String(l._id)));
  const outOfScope = leadIds.filter((id) => !inScopeIds.has(String(id)));
  if (outOfScope.length) {
    throw httpError(403, `Out of your scope: ${outOfScope.join(", ")} — batch rejected`);
  }

  const fromById = new Map(inScope.map((l) => [String(l._id), l.assignedTo]));
  await Enquiry.updateMany(
    { _id: { $in: leadIds } },
    { $set: { assignedTo: target._id, updatedBy: actorId || null } }
  );
  for (const id of leadIds) {
    await LeadInternalEventService.record({
      leadId: id,
      type: "transferred",
      actorId,
      payload: {
        from: fromById.get(String(id)) ? String(fromById.get(String(id))) : null,
        to: String(target._id),
        toName: target.name,
      },
    });
  }
  return { transferred: leadIds.length, to: String(target._id), toName: target.name };
};

module.exports = {
  recycleLead,
  resurfaceDueLeads,
  completeFollowUp,
  isOpenLead,
  setTags,
  bulkTransfer,
  RECYCLE_REASONS,
  COMPLETION_OUTCOMES,
};
