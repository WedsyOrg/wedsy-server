const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const EnquiryRepository = require("../repositories/EnquiryRepository");
const EnquiryService = require("./EnquiryService");
const CallCockpitService = require("./CallCockpitService");
const LeadAssignmentService = require("./LeadAssignmentService");
const LeadInternalEventService = require("./LeadInternalEventService");
const AdminNotificationService = require("./AdminNotificationService");

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
        // Mid-qualify slice: a call completed THROUGH a follow-up is by
        // definition a follow-up call.
        purpose: "follow_up",
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

  // Signal spine: completing a cadence follow-up is employee activity (the
  // call-shaped branch above already stamped firstRespondedAt inside logCall).
  await EnquiryRepository.touchLastActivity(enquiryId);

  const fresh = await EnquiryRepository.findById(enquiryId);
  const obj = fresh.toObject();
  if (cadence) obj.cadence = cadence;
  obj.appliedAction = appliedAction;
  return obj;
};

// ── Slice B2 — the deal spine's "proposal sent" signal ───────────────────────
// SET-ONCE (atomic: the filter re-checks null, so a concurrent second press
// loses and 409s). Amount optional (rupees). Stamps the activity spine and
// logs a proposal_sent journey event. The spine station derives on read.
const markProposalSent = async (enquiryId, { amount } = {}, actorId) => {
  assertValidId(enquiryId);
  const lead = await EnquiryRepository.findById(enquiryId);
  if (!lead) throw httpError(404, "Enquiry not found");
  if (lead.proposalSentAt) throw httpError(409, "Proposal is already marked sent on this lead");

  let amt = null;
  if (amount !== undefined && amount !== null && amount !== "") {
    amt = Number(amount);
    if (!Number.isFinite(amt) || amt < 0) throw httpError(400, "Invalid amount");
  }
  const fields = { proposalSentAt: new Date() };
  if (amt != null) fields.proposalAmount = amt;
  const updated = await Enquiry.findOneAndUpdate(
    { _id: enquiryId, proposalSentAt: null },
    { $set: fields },
    { new: true }
  );
  if (!updated) throw httpError(409, "Proposal is already marked sent on this lead");

  await EnquiryRepository.touchLastActivity(enquiryId);
  await LeadInternalEventService.record({
    leadId: enquiryId,
    type: "proposal_sent",
    actorId: actorId || null,
    payload: amt != null ? { amount: amt } : {},
  });
  // Slice B3 — echo into the lead_comms lane (fire-safe no-op without lanes).
  await require("./LeadLaneService").autoEntry(
    enquiryId,
    "lead_comms",
    "proposal_sent",
    amt != null ? `Proposal sent · ₹${amt.toLocaleString("en-IN")}` : "Proposal sent"
  );
  return updated;
};

// ── Slice B5a — deal total + THE ONBOARD HINGE ────────────────────────────────
const setDealTotal = async (enquiryId, amount, actorId) => {
  assertValidId(enquiryId);
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt < 0) throw httpError(400, "amount must be a non-negative number");
  const lead = await EnquiryRepository.findById(enquiryId);
  if (!lead) throw httpError(404, "Enquiry not found");
  const from = lead.dealTotal != null ? Number(lead.dealTotal) : null;
  const updated = await EnquiryRepository.updateFieldsById(enquiryId, { dealTotal: amt });
  await LeadInternalEventService.record({
    leadId: enquiryId,
    type: "deal_total_changed",
    actorId: actorId || null,
    payload: { from, to: amt },
  });
  return updated;
};

// The WIN BROADCAST — the whole team hears the bell (audience per settings
// broadcast.winAudience). NEVER carries any amount. Fire-safe.
const broadcastWin = async (lead, actorId) => {
  try {
    const Role = require("../models/Role");
    const audienceSetting = await SettingsService.get("broadcast.winAudience");
    let recipients = [];
    if (audienceSetting === "sales_cs_leadership") {
      const names = ["Revenue Head", "Founder", "Sales Lead", "Client Servicing Executive"];
      const roles = await Role.find({ name: { $in: names }, deletedAt: null }, { _id: 1 }).lean();
      const roleIds = roles.map((r) => r._id);
      const admins = await Admin.find(
        { status: "active", $or: [{ roleId: { $in: roleIds } }, { roleIds: { $in: roleIds } }] },
        { _id: 1 }
      ).lean();
      recipients = admins.map((a) => a._id);
      if (lead.assignedTo) recipients.push(lead.assignedTo);
    } else {
      const admins = await Admin.find({ status: "active" }, { _id: 1 }).lean();
      recipients = admins.map((a) => a._id);
    }
    const ownerDoc = lead.assignedTo ? await Admin.findById(lead.assignedTo, { name: 1 }).lean() : null;
    const q = lead.qualificationData || {};
    const couple = q.groomName && q.brideName ? `${q.groomName} & ${q.brideName}` : lead.name || "The couple";
    // Actor INCLUDED — they earned the bell. Dedupe ids only.
    const ids = [...new Set(recipients.map(String))];
    await AdminNotificationService.notify(ids, {
      type: "client_won",
      title: `🏆 Client won by ${ownerDoc ? ownerDoc.name : "the team"}`,
      message: `${couple} is now a Wedsy client`,
      leadId: lead._id,
      // Deliberately NO amount anywhere in the broadcast.
      payload: { wonBy: lead.assignedTo ? String(lead.assignedTo) : null, onboardedBy: actorId ? String(actorId) : null },
    });
  } catch (e) {
    console.error("[broadcastWin] failed:", e.message);
  }
};

// POST /enquiry/:_id/onboard { feeAmount, dealTotal?, mode?, note? } — the win
// hinge: onboard from ANY live stage (the meeting_scheduled gate is gone; the
// legacy /convert route keeps it). In order: dealTotal → Project + stage won
// (the ONE shared convertLead path, gate skipped) → fee payment #1 → journey
// event → lane echo → win broadcast.
const onboardClient = async (enquiryId, { feeAmount, dealTotal, mode, note } = {}, actorId) => {
  assertValidId(enquiryId);
  const lead = await EnquiryRepository.findById(enquiryId);
  if (!lead) throw httpError(404, "Enquiry not found");
  if (!lead.qualified) throw httpError(422, "Qualify the lead before onboarding");
  if (lead.lostStatus === "pending") throw httpError(422, "A disqualification decision is pending on this lead");
  if (lead.isLost || lead.lostStatus === "approved" || lead.stage === "lost") {
    throw httpError(422, "This lead is lost — recover it before onboarding");
  }
  if (lead.stage === "won") throw httpError(409, "This client is already onboarded");
  const existingProject = await require("../repositories/ProjectRepository").findByLeadId(enquiryId);
  if (existingProject) throw httpError(409, "This client is already onboarded");

  const fee = Number(feeAmount);
  if (!Number.isFinite(fee) || fee <= 0) throw httpError(400, "feeAmount must be a positive number");

  if (dealTotal !== undefined && dealTotal !== null && dealTotal !== "") {
    await setDealTotal(enquiryId, dealTotal, actorId);
  }
  const effectiveTotal =
    dealTotal != null && dealTotal !== "" ? Number(dealTotal) : lead.dealTotal != null ? Number(lead.dealTotal) : 0;

  // Project + stage → won through the ONE shared path (gate skipped).
  const project = await require("./ProjectService").convertLead(
    enquiryId,
    { value: effectiveTotal, skipStageGate: true },
    actorId
  );

  // Fee payment #1 (mode default "bank"; the ledger echoes lead_comms itself).
  const payment = await require("./LeadPaymentService").record(
    enquiryId,
    { amount: fee, mode: mode || "bank", note: note || "Onboarding fee", projectId: project._id },
    actorId
  );

  await LeadInternalEventService.record({
    leadId: enquiryId,
    type: "client_onboarded",
    actorId: actorId || null,
    payload: { projectId: String(project._id), feeRecorded: true },
  });
  await require("./LeadLaneService").autoEntry(
    enquiryId,
    "lead_comms",
    "agreement",
    "Client onboarded 🏆 — agreement & fee in"
  );
  await broadcastWin(lead, actorId);

  const fresh = await Enquiry.findById(enquiryId).lean();
  return { lead: fresh, project, payment };
};

// ── Quick notes (Redesign) ───────────────────────────────────────────────────
// One note = one "commented" internal event (shows in the journey) + an append
// to the legacy updates.notes blob so the old surfaces keep seeing it.
const addNote = async (enquiryId, text, actorId) => {
  assertValidId(enquiryId);
  if (typeof text !== "string" || !text.trim()) throw httpError(400, "Note text is required");
  if (text.length > 2000) throw httpError(400, "Notes are capped at 2000 characters");
  const lead = await EnquiryRepository.findById(enquiryId);
  if (!lead) throw httpError(404, "Enquiry not found");
  const clean = text.trim();
  await LeadInternalEventService.record({
    leadId: enquiryId,
    type: "commented",
    actorId,
    payload: { text: clean },
  });
  const stamp = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  const legacy = lead.updates?.notes ? `${lead.updates.notes}\n\n[${stamp}] ${clean}` : `[${stamp}] ${clean}`;
  const updated = await EnquiryRepository.updateFieldsById(enquiryId, { "updates.notes": legacy });
  // Signal spine: the notes blob is employee activity (touched) but carries no
  // per-note timestamp, so it never contributes to firstRespondedAt.
  await EnquiryRepository.touchLastActivity(enquiryId);
  return updated;
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

// ── Lead-detail cockpit — build the formal Event (events collection) from the
// lead's captured day/function draft (qualificationData.eventDays). This is the
// ONLY place the Event is born now: the per-call /qualification save stores the
// draft on the lead and creates NO Event. Flattens days → one Event day per
// FULLY-SPECIFIED function (type + time + venue all present). The Event model
// requires a date, so a qualifying function on a dateless day falls back to the
// lead's derived canonical eventDate; if neither yields a date, that entry is
// skipped (it cannot satisfy the required schema). Fire-safe: never throws out
// of the qualify transition, mirroring the journey/summary side-effects.
const buildEventFromDraft = async (lead) => {
  try {
    const qd = lead.qualificationData || {};
    const days = Array.isArray(qd.eventDays) ? qd.eventDays : [];
    if (!days.length) return;
    const canonicalDate = isIsoLike(qd.eventDate) ? qd.eventDate : "";

    const eventDays = [];
    for (const day of days) {
      if (!day || typeof day !== "object") continue;
      const dayDate =
        typeof day.date === "string" && day.date.trim() ? day.date.trim() : canonicalDate;
      if (!dayDate) continue; // Event.eventDays.date is required.
      const fns = Array.isArray(day.functions) ? day.functions : [];
      for (const fn of fns) {
        if (!fn || typeof fn !== "object") continue;
        const type = (fn.type || "").trim();
        const time = (fn.time || "").trim();
        const venue = (fn.venue || "").trim();
        if (!type || !time || !venue) continue; // fully-specified only
        eventDays.push({
          name: type,
          date: dayDate,
          time,
          venue,
          eventSpace: (fn.space || "").trim(),
          notes: (fn.pax || "").trim() ? `Pax: ${(fn.pax || "").trim()}` : "",
        });
      }
    }
    if (!eventDays.length) return;

    // Link (or create) the User by phone, mirroring the Kiara CRM-sync idiom.
    const User = require("../models/User");
    const Event = require("../models/Event");
    let user = await User.findOne({ phone: lead.phone });
    if (!user) {
      user = await new User({ name: lead.name, phone: lead.phone }).save();
    }
    // Idempotent: an existing Event means the sales team curates from there —
    // never overwrite (matches KiaraCrmSyncService.ensureEventDays).
    const existing = await Event.findOne({ user: user._id });
    if (existing) return;

    await new Event({
      user: user._id,
      name: lead.name,
      groomName: qd.groomName || null,
      brideName: qd.brideName || null,
      eventType: qd.weddingStyle || "",
      eventDate: canonicalDate,
      eventDays,
    }).save();
  } catch (e) {
    console.error("[qualifyLead] event creation failed:", e.message);
  }
};

const isIsoLike = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.trim());

// ── MB9a Slice 3 — THE QUALIFY HINGE (single source of the qualified transition).
// Both the Call Cockpit qualified-outcome path AND the explicit Qualify button
// converge HERE so there is no fork. On the (idempotent) transition:
//   1. mark the lead qualified;
//   2. hand ownership to the sales lead — the assignee's reporting manager — or
//      keep the assignee if they have no manager (they ARE the lead);
//   3. instantiate the journey steps (MB8b) — the journey is BORN here, and the
//      MB8b guard keeps it a no-op if steps already exist;
//   4. trigger the Kiara summary.
// Fire-safe: the journey/summary side-effects never throw out of the transition.
const qualifyLead = async (enquiryId, actorId) => {
  assertValidId(enquiryId);
  const lead = await Enquiry.findById(enquiryId);
  if (!lead) throw httpError(404, "Enquiry not found");
  // Idempotent: qualifying an already-qualified lead is a no-op (no double
  // journey instantiation, no second handoff).
  if (lead.qualified) return { lead: lead.toObject(), alreadyQualified: true, handedOff: false };

  // Ownership handoff to the sales lead (the assignee's reporting manager).
  let newOwnerId = lead.assignedTo || null;
  if (lead.assignedTo) {
    const assignee = await Admin.findById(lead.assignedTo, { reportingManagerId: 1 }).lean();
    if (assignee && assignee.reportingManagerId) newOwnerId = assignee.reportingManagerId;
  }
  const handedOff = !!newOwnerId && String(newOwnerId) !== String(lead.assignedTo || "");

  // MB11c — carry the qualifier's credit forward at the handoff. qualifiedAt is
  // set-once here (this branch only runs on the first qualification — the early
  // idempotent return guards re-entry). qualifiedBy is set-once too: we don't
  // clobber an existing credit (e.g. the MB5 meet-handoff intern), otherwise we
  // record whoever fired the hinge. The pre-qual record (callLog, notes,
  // qualificationData, kiaraAnswers, kiaraSummary) already lives on this same
  // Enquiry doc and survives untouched — this only adds the missing "who/when".
  const fields = { qualified: true, qualifiedAt: lead.qualifiedAt || new Date() };
  if (handedOff) fields.assignedTo = newOwnerId;
  if (!lead.qualifiedBy && actorId) fields.qualifiedBy = actorId;
  // SEQ-3b — qualifying gives the lead a clear path forward, so any "no further
  // action" marker from an earlier no-next-step save is cleared at the hinge.
  fields["noFurtherAction.flagged"] = false;
  fields["noFurtherAction.flaggedAt"] = null;
  fields["noFurtherAction.flaggedReason"] = "";
  await EnquiryRepository.updateFieldsById(enquiryId, fields);

  await LeadInternalEventService.record({
    leadId: enquiryId,
    type: "qualified",
    actorId: actorId || null,
    payload: { handedOff, owner: newOwnerId ? String(newOwnerId) : null },
  });
  // The ownership handoff reads as a transfer in the journey (from/to are
  // name-resolved by JourneyService).
  if (handedOff) {
    await LeadInternalEventService.record({
      leadId: enquiryId,
      type: "transferred",
      actorId: actorId || null,
      payload: { from: String(lead.assignedTo), to: String(newOwnerId), reason: "qualify_handoff" },
    });
    // Signal Matrix Slice 3 — roster continuity: the handoff moves assignedTo to
    // the manager, which would otherwise drop the qualifying rep out of edit
    // scope on their own lead. Keep them on as a team member (idempotent:
    // addMember 409s on an existing active membership). Fire-safe — a roster
    // hiccup (e.g. multi-department person needing an explicit pick) must never
    // break the qualify hinge.
    try {
      await require("./LeadTeamService").addMember(
        enquiryId,
        { personId: lead.assignedTo, role: "qualifier" },
        actorId
      );
    } catch (e) {
      if (e.status !== 409) {
        console.error("[qualifyLead] roster continuity add failed:", e.message);
      }
    }
    // Slice B1 — tell the NEW owner they just received a qualified lead (the
    // handoff was silent). Actor excluded (self-qualify onto yourself happens
    // when the owner has no manager — handedOff is false then anyway).
    // AdminNotificationService.notify is itself fire-safe.
    if (String(newOwnerId) !== String(actorId || "")) {
      const q = lead.qualificationData || {};
      const couple =
        q.groomName && q.brideName ? `${q.groomName} & ${q.brideName}` : lead.name || "a lead";
      await AdminNotificationService.notify(newOwnerId, {
        type: "lead_qualified_handoff",
        title: `New qualified lead: ${couple}`,
        message: "Qualified and handed to you — the journey and roster are live.",
        leadId: enquiryId,
        payload: { qualifiedBy: actorId ? String(actorId) : null },
      });
    }
  }

  // Lead-detail cockpit — the formal Event is BORN here from the captured draft
  // (never on a plain discovery-call save). Fire-safe.
  await buildEventFromDraft(lead);

  // The journey is BORN here (MB8b idempotent guard inside). Fire-safe.
  try {
    await require("./LeadStepService").instantiateForLead(enquiryId, actorId);
  } catch (e) {
    console.error("[qualifyLead] journey instantiate failed:", e.message);
  }
  // Kiara summary — worth paying for once qualified. Fire-safe.
  try {
    await require("./KiaraSummaryService").generateForQualified(enquiryId);
  } catch (e) {
    console.error("[qualifyLead] summary failed:", e.message);
  }

  const fresh = await Enquiry.findById(enquiryId).lean();
  return { lead: fresh, alreadyQualified: false, handedOff };
};

// ── #8 — UNQUALIFY (reverse a qualification). A sales lead / revenue head (or the
// assignee's manager — eligibility checked in the controller) can undo a wrongly
// qualified lead: it flips `qualified` back off, returns ownership to the intern
// who qualified it, tags it "Unqualified", and notifies that intern internally.
// Deliberately NON-destructive: stage, qualificationData, qualifierNotes, name,
// callLog, kiaraSummary and the journey steps are all left untouched.
const UNQUALIFIED_TAG = "Unqualified";
const unqualifyLead = async (enquiryId, actorId, { reason } = {}) => {
  assertValidId(enquiryId);
  const lead = await Enquiry.findById(enquiryId);
  if (!lead) throw httpError(404, "Enquiry not found");
  // Idempotent: nothing to reverse on a lead that isn't qualified.
  if (!lead.qualified) return lead.toObject();
  // A reason is mandatory (audit trail + the intern's notification body).
  const cleanReason = typeof reason === "string" ? reason.trim() : "";
  if (!cleanReason) throw httpError(400, "A reason is required to unqualify a lead");

  // Capture BEFORE mutating — qualifiedBy is the intern we return the lead to.
  const intern = lead.qualifiedBy || null;
  const previousOwner = lead.assignedTo || null;

  // Make "Unqualified" a recognized, filterable tag: add it to the Settings
  // library if missing, then union it onto the lead's tags.
  const library = await SettingsService.get("tags.available");
  if (!library.includes(UNQUALIFIED_TAG)) {
    await SettingsService.set("tags.available", [...library, UNQUALIFIED_TAG], actorId);
  }
  const nextTags = [...new Set([...(lead.tags || []), UNQUALIFIED_TAG])];

  await EnquiryRepository.updateFieldsById(enquiryId, {
    qualified: false,
    qualifiedAt: null,
    qualifiedBy: null,
    assignedTo: intern, // back to the intern who qualified it
    tags: nextTags,
  });

  await LeadInternalEventService.record({
    leadId: enquiryId,
    type: "unqualified",
    actorId: actorId || null,
    payload: {
      reason: cleanReason,
      previousOwner: previousOwner ? String(previousOwner) : null,
      returnedTo: intern ? String(intern) : null,
    },
  });

  // Internal notification ONLY (never the external NotificationService). notify
  // is fire-safe and no-ops on a null recipient.
  await AdminNotificationService.notify(intern, {
    type: "lead_unqualified",
    title: `Lead unqualified: ${lead.name}`,
    message: cleanReason,
    leadId: enquiryId,
  });

  return await Enquiry.findById(enquiryId).lean();
};

module.exports = {
  recycleLead,
  resurfaceDueLeads,
  completeFollowUp,
  isOpenLead,
  setTags,
  bulkTransfer,
  addNote,
  qualifyLead,
  unqualifyLead,
  markProposalSent,
  setDealTotal,
  onboardClient,
  RECYCLE_REASONS,
  COMPLETION_OUTCOMES,
};
