const mongoose = require("mongoose");
const EnquiryRepository = require("../repositories/EnquiryRepository");
const AdminRepository = require("../repositories/AdminRepository");
const StageRepository = require("../repositories/StageRepository");
const ActivityLogService = require("./ActivityLogService");
// Shared eligibility helpers — imported here (not from controllers/disqualify) so there is
// no controller <-> service circular require.
const {
  isManagerOfAssigned,
  actorHasApprovePermission,
} = require("./ApprovalEligibility");

// Fixed set of disqualification reasons. Kept as a plain constant (no enum on the field).
const LOST_REASONS = ["budget", "competitor", "not_responsive", "not_a_fit", "other"];

const httpError = (status, message) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

// Update an enquiry's pipeline stage.
// Throws { status, message } shaped errors for the controller to map to HTTP responses.
const updateStage = async (enquiryId, stage, updatedBy) => {
  if (typeof stage !== "string" || stage.length === 0) {
    throw httpError(400, "Stage is required");
  }
  const validStage = await StageRepository.findBySlug(stage);
  if (!validStage) {
    throw httpError(400, `Invalid stage: ${stage}`);
  }
  if (!mongoose.Types.ObjectId.isValid(enquiryId)) {
    throw httpError(400, "Invalid enquiry id");
  }
  // Interception: moving a lead into a "lost"-category stage (e.g. dragging it into the
  // Lost column) does NOT change the stage directly — it opens a disqualification REQUEST
  // that must be approved. lostStatus guards (pending/approved) propagate from there.
  if (validStage.category === "lost") {
    return await requestDisqualification(
      enquiryId,
      { reason: "other", note: "Requested via stage change" },
      updatedBy
    );
  }

  // Non-lost target. Load the lead so we can detect a REOPEN: an approved- or pending-lost
  // lead moved back to an open stage must clear its active lost state (otherwise lostStatus/
  // isLost would go stale and contradict the new stage).
  const enquiry = await EnquiryRepository.findById(enquiryId);
  if (!enquiry) {
    throw httpError(404, "Enquiry not found");
  }

  if (enquiry.lostStatus === "approved" || enquiry.lostStatus === "pending") {
    const previousLostStatus = enquiry.lostStatus;
    // Reset the ACTIVE lost state but KEEP the historical audit fields (lostReason,
    // lostRequestedBy/At, lostDecidedBy/At, lostDecisionNote) so we retain what happened.
    const reopened = await EnquiryRepository.updateFieldsById(enquiryId, {
      stage,
      updatedBy,
      lostStatus: "none",
      isLost: false,
      stageBeforeLost: "",
    });
    await ActivityLogService.record({
      actorId: updatedBy,
      action: "lead.reopened",
      entityType: "lead",
      entityId: String(enquiryId),
      summary: `Lead reopened (moved to ${stage})`,
      meta: { fromLostStatus: previousLostStatus, toStage: stage },
    });
    return reopened;
  }

  // Not in a lost state ("none"/"rejected") — normal stage move, no lost-field writes.
  const updated = await EnquiryRepository.updateStageById(
    enquiryId,
    stage,
    updatedBy
  );
  if (!updated) {
    throw httpError(404, "Enquiry not found");
  }
  return updated;
};

// Request that a lead be disqualified (marked lost). Pending approval afterward.
const requestDisqualification = async (enquiryId, { reason, note } = {}, actorId) => {
  if (!mongoose.Types.ObjectId.isValid(enquiryId)) {
    throw httpError(400, "Invalid enquiry id");
  }
  if (!LOST_REASONS.includes(reason)) {
    throw httpError(400, "Invalid reason");
  }
  if (note !== undefined && note !== null && typeof note !== "string") {
    throw httpError(400, "Invalid note");
  }

  const enquiry = await EnquiryRepository.findById(enquiryId);
  if (!enquiry) {
    throw httpError(404, "Enquiry not found");
  }
  if (enquiry.lostStatus === "pending") {
    throw httpError(400, "Already pending approval");
  }
  if (enquiry.lostStatus === "approved") {
    throw httpError(400, "Lead is already lost");
  }

  const updated = await EnquiryRepository.updateFieldsById(enquiryId, {
    lostStatus: "pending",
    lostReason: reason,
    lostNote: note || "",
    lostRequestedBy: actorId || null,
    lostRequestedAt: new Date(),
    stageBeforeLost: enquiry.stage,
  });

  await ActivityLogService.record({
    actorId,
    action: "lead.disqualify_requested",
    entityType: "lead",
    entityId: String(enquiryId),
    summary: `Disqualification requested (reason: ${reason})`,
    meta: { reason, note: note || "" },
  });

  return updated;
};

// Decide on a pending disqualification request. `canApprove` is computed by the controller
// (assigned person's manager OR holder of a leads:approve permission) and passed in.
const decideDisqualification = async (
  enquiryId,
  { decision, note } = {},
  actorId,
  canApprove
) => {
  if (decision !== "approve" && decision !== "reject") {
    throw httpError(400, "Invalid decision");
  }
  if (!mongoose.Types.ObjectId.isValid(enquiryId)) {
    throw httpError(400, "Invalid enquiry id");
  }

  const enquiry = await EnquiryRepository.findById(enquiryId);
  if (!enquiry) {
    throw httpError(404, "Enquiry not found");
  }
  if (enquiry.lostStatus !== "pending") {
    throw httpError(400, "No pending disqualification");
  }
  if (!canApprove) {
    throw httpError(403, "Not authorized to approve this disqualification");
  }

  if (decision === "approve") {
    const updated = await EnquiryRepository.updateFieldsById(enquiryId, {
      lostStatus: "approved",
      lostDecidedBy: actorId || null,
      lostDecidedAt: new Date(),
      lostDecisionNote: note || "",
      isLost: true,
      stage: "lost",
    });
    await ActivityLogService.record({
      actorId,
      action: "lead.disqualify_approved",
      entityType: "lead",
      entityId: String(enquiryId),
      summary: "Disqualification approved",
      meta: { movedToStage: "lost", reason: enquiry.lostReason },
    });
    return updated;
  }

  // decision === "reject": restore the pre-lost stage (if we captured one).
  const restoreFields = {
    lostStatus: "rejected",
    lostDecidedBy: actorId || null,
    lostDecidedAt: new Date(),
    lostDecisionNote: note || "",
  };
  if (enquiry.stageBeforeLost) {
    restoreFields.stage = enquiry.stageBeforeLost;
  }
  const updated = await EnquiryRepository.updateFieldsById(enquiryId, restoreFields);
  await ActivityLogService.record({
    actorId,
    action: "lead.disqualify_rejected",
    entityType: "lead",
    entityId: String(enquiryId),
    summary: "Disqualification rejected",
    meta: { restoredStage: enquiry.stageBeforeLost, note: note || "" },
  });
  return updated;
};

// Assign an enquiry to an admin (or unassign by passing null).
const updateAssignedTo = async (enquiryId, assignedTo, updatedBy) => {
  if (assignedTo === undefined) {
    const err = new Error("assignedTo is required (use null to unassign)");
    err.status = 400;
    throw err;
  }
  if (!mongoose.Types.ObjectId.isValid(enquiryId)) {
    const err = new Error("Invalid enquiry id");
    err.status = 400;
    throw err;
  }
  if (assignedTo !== null) {
    if (!mongoose.Types.ObjectId.isValid(assignedTo)) {
      const err = new Error(
        "Invalid assignedTo: must be an Admin _id or null"
      );
      err.status = 400;
      throw err;
    }
    const admin = await AdminRepository.findById(assignedTo);
    if (!admin) {
      const err = new Error("Admin not found");
      err.status = 404;
      throw err;
    }
  }
  const updated = await EnquiryRepository.updateAssignedToById(
    enquiryId,
    assignedTo,
    updatedBy
  );
  if (!updated) {
    const err = new Error("Enquiry not found");
    err.status = 404;
    throw err;
  }
  return updated;
};

// Map a populated admin ref (or null) to a trimmed { _id, name } shape.
const trimAdminRef = (ref) =>
  ref && ref._id ? { _id: ref._id, name: ref.name } : null;

// List pending-disqualification leads the given admin is allowed to approve.
// - leads:approve holders see ALL pending leads.
// - otherwise, only pending leads where the admin is the assigned person's manager.
//   (Pending leads with no assignedTo are not visible to manager-only viewers.)
const listPendingForApprover = async (actorId) => {
  const pending = await EnquiryRepository.findPendingDisqualifications();
  const canAll = await actorHasApprovePermission(actorId);

  let filtered;
  if (canAll) {
    filtered = pending;
  } else {
    // isManagerOfAssigned is async — use a sequential loop, not Array.filter.
    filtered = [];
    for (const lead of pending) {
      if (
        lead.assignedTo &&
        lead.assignedTo._id &&
        (await isManagerOfAssigned(actorId, lead.assignedTo._id))
      ) {
        filtered.push(lead);
      }
    }
  }

  return filtered.map((lead) => ({
    _id: lead._id,
    name: lead.name,
    phone: lead.phone,
    stage: lead.stage,
    assignedTo: trimAdminRef(lead.assignedTo),
    lostReason: lead.lostReason,
    lostNote: lead.lostNote,
    lostRequestedBy: trimAdminRef(lead.lostRequestedBy),
    lostRequestedAt: lead.lostRequestedAt,
  }));
};

module.exports = {
  updateStage,
  updateAssignedTo,
  requestDisqualification,
  decideDisqualification,
  listPendingForApprover,
  LOST_REASONS,
};
