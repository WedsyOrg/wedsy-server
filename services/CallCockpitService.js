const mongoose = require("mongoose");
const EnquiryRepository = require("../repositories/EnquiryRepository");
const LeadInternalEventService = require("./LeadInternalEventService");

const CALL_OUTCOMES = ["", "qualified", "busy", "unknown", "disqualified"];
const FOLLOW_UP_TYPES = ["meet", "call", "visit"];
// Whitelisted qualificationData fields a PUT may write (everything else is ignored).
const QUALIFICATION_STRING_FIELDS = [
  "groomName",
  "brideName",
  "weddingStyle",
  "venueStatus",
  "venueName",
  "venueTypeWanted",
  "venueArea",
  "venueBudget",
  "venueShortlistNote",
  "email",
  "whatsappNumber",
];
const QUALIFICATION_BOOLEAN_FIELDS = ["emailNotWilling", "whatsappSameNumber"];

const httpError = (status, message) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

const assertValidId = (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw httpError(400, "Invalid enquiry id");
  }
};

const parseDate = (value, fieldName) => {
  const d = new Date(value);
  if (!value || Number.isNaN(d.getTime())) {
    throw httpError(400, `Invalid ${fieldName}`);
  }
  return d;
};

// Does the lead have at least one follow-up scheduled in the future?
const hasFutureFollowUp = (enquiry, now = new Date()) =>
  (enquiry.followUps || []).some(
    (f) => f.scheduledAt && new Date(f.scheduledAt) > now
  );

// POST /enquiry/:_id/call-log — append-only. Stamps firstCalledAt on the first
// call ever (set-once, via the SetFirstCall logic) and flips `qualified` when the
// outcome is "qualified".
const logCall = async (
  enquiryId,
  { startedAt, durationSeconds, connected, outcome, notes } = {},
  actorId
) => {
  assertValidId(enquiryId);
  const startedAtDate = parseDate(startedAt, "startedAt");
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration < 0) {
    throw httpError(400, "Invalid durationSeconds");
  }
  if (outcome !== undefined && !CALL_OUTCOMES.includes(outcome)) {
    throw httpError(400, `Invalid outcome (expected one of: ${CALL_OUTCOMES.filter(Boolean).join(", ")})`);
  }
  if (notes !== undefined && typeof notes !== "string") {
    throw httpError(400, "Invalid notes");
  }

  const enquiry = await EnquiryRepository.findById(enquiryId);
  if (!enquiry) {
    throw httpError(404, "Enquiry not found");
  }

  const entry = {
    startedAt: startedAtDate,
    durationSeconds: duration,
    connected: connected === true,
    outcome: outcome || "",
    notes: notes || "",
    loggedBy: actorId || null,
  };
  const extraSet = outcome === "qualified" ? { qualified: true } : {};
  const updated = await EnquiryRepository.pushCallLogById(enquiryId, entry, extraSet);

  // First call on this lead → stamp the TAT anchor (no-op for later calls).
  const stamped = await EnquiryRepository.stampFirstCalledAt(enquiryId);

  await LeadInternalEventService.record({
    leadId: enquiryId,
    type: "call_logged",
    actorId,
    payload: {
      outcome: entry.outcome,
      durationSeconds: entry.durationSeconds,
      connected: entry.connected,
    },
  });

  // Prefer the stamped doc (it carries the fresh firstCalledAt) when this was the first call.
  return stamped || updated;
};

// POST /enquiry/:_id/follow-up
const addFollowUp = async (
  enquiryId,
  { type, scheduledAt, promiseNote } = {},
  actorId
) => {
  assertValidId(enquiryId);
  if (!FOLLOW_UP_TYPES.includes(type)) {
    throw httpError(400, `Invalid type (expected one of: ${FOLLOW_UP_TYPES.join(", ")})`);
  }
  const scheduledAtDate = parseDate(scheduledAt, "scheduledAt");
  if (promiseNote !== undefined && typeof promiseNote !== "string") {
    throw httpError(400, "Invalid promiseNote");
  }

  const enquiry = await EnquiryRepository.findById(enquiryId);
  if (!enquiry) {
    throw httpError(404, "Enquiry not found");
  }

  const updated = await EnquiryRepository.pushFollowUpById(enquiryId, {
    type,
    scheduledAt: scheduledAtDate,
    promiseNote: promiseNote || "",
    createdBy: actorId || null,
  });

  await LeadInternalEventService.record({
    leadId: enquiryId,
    type: "follow_up_scheduled",
    actorId,
    payload: { followUpType: type, scheduledAt: scheduledAtDate, promiseNote: promiseNote || "" },
  });

  return updated;
};

// PUT /enquiry/:_id/qualification — partial update; only whitelisted fields are
// written (dot-path $set so omitted fields are never clobbered).
const updateQualification = async (enquiryId, body = {}, actorId) => {
  assertValidId(enquiryId);

  const set = {};
  for (const field of QUALIFICATION_STRING_FIELDS) {
    if (body[field] !== undefined) {
      if (typeof body[field] !== "string") {
        throw httpError(400, `Invalid ${field}`);
      }
      set[`qualificationData.${field}`] = body[field];
    }
  }
  for (const field of QUALIFICATION_BOOLEAN_FIELDS) {
    if (body[field] !== undefined) {
      if (typeof body[field] !== "boolean") {
        throw httpError(400, `Invalid ${field}`);
      }
      set[`qualificationData.${field}`] = body[field];
    }
  }
  if (Object.keys(set).length === 0) {
    throw httpError(400, "No valid qualification fields provided");
  }

  const updated = await EnquiryRepository.updateFieldsById(enquiryId, set);
  if (!updated) {
    throw httpError(404, "Enquiry not found");
  }

  await LeadInternalEventService.record({
    leadId: enquiryId,
    type: "qualification_updated",
    actorId,
    payload: { fields: Object.keys(set).map((k) => k.replace("qualificationData.", "")) },
  });

  return updated;
};

// POST /enquiry/:_id/call-complete — server-side mirror of the UI gate:
// a qualified lead CANNOT be saved as complete without a future follow-up locked.
// An explicit incomplete=true bypasses, with the acknowledged gaps recorded on the lead.
const completeCall = async (enquiryId, { incomplete, gaps } = {}, actorId) => {
  assertValidId(enquiryId);

  const enquiry = await EnquiryRepository.findById(enquiryId);
  if (!enquiry) {
    throw httpError(404, "Enquiry not found");
  }

  const isIncomplete = incomplete === true;
  if (isIncomplete) {
    if (
      gaps !== undefined &&
      (!Array.isArray(gaps) || gaps.some((g) => typeof g !== "string"))
    ) {
      throw httpError(400, "Invalid gaps (expected an array of strings)");
    }
  } else if (enquiry.qualified && !hasFutureFollowUp(enquiry)) {
    throw httpError(
      400,
      "Cannot complete: a qualified call must end with a future follow-up locked. Lock the next step, or save with incomplete=true to record the gap."
    );
  }

  const updated = await EnquiryRepository.updateFieldsById(enquiryId, {
    "callCompletion.status": isIncomplete ? "incomplete" : "complete",
    "callCompletion.gaps": isIncomplete ? gaps || [] : [],
    "callCompletion.completedAt": new Date(),
    "callCompletion.completedBy": actorId || null,
  });

  await LeadInternalEventService.record({
    leadId: enquiryId,
    type: "call_completed",
    actorId,
    payload: { incomplete: isIncomplete, gaps: isIncomplete ? gaps || [] : [] },
  });

  return updated;
};

const listInternalEvents = async (enquiryId) => {
  assertValidId(enquiryId);
  return await LeadInternalEventService.listForLead(enquiryId);
};

module.exports = {
  logCall,
  addFollowUp,
  updateQualification,
  completeCall,
  listInternalEvents,
  hasFutureFollowUp,
};
