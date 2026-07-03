const Enquiry = require("../models/Enquiry");

// Find an enquiry by _id. Returns the document or null.
const findById = async (_id) => {
  return await Enquiry.findById(_id);
};

// Update an enquiry's stage by _id. Returns the updated document or null.
const updateStageById = async (_id, stage, updatedBy) => {
  return await Enquiry.findByIdAndUpdate(
    _id,
    { stage, updatedBy },
    { new: true, runValidators: true, context: "query" }
  );
};

// Update an enquiry's assignedTo by _id. assignedTo can be an Admin _id or null.
// Returns the updated document or null.
const updateAssignedToById = async (_id, assignedTo, updatedBy) => {
  return await Enquiry.findByIdAndUpdate(
    _id,
    { assignedTo, updatedBy },
    { new: true, runValidators: true, context: "query" }
  );
};

// MB9a-2 — ATOMIC first-claim-wins reassign. The update applies ONLY while the
// lead is still owned by `expectedOwnerId`; MongoDB serializes the conditional
// findOneAndUpdate, so of two concurrent claimers exactly one matches (the other
// gets null → 409). No new schema field — the assignedTo precondition IS the lock.
const claimByReassign = async (_id, expectedOwnerId, newOwnerId, updatedBy) => {
  return await Enquiry.findOneAndUpdate(
    { _id, assignedTo: expectedOwnerId },
    { $set: { assignedTo: newOwnerId, updatedBy: updatedBy || null } },
    { new: true }
  ).lean();
};

// Set arbitrary fields on an enquiry by _id. Returns the updated document or null.
const updateFieldsById = async (_id, fields) => {
  return await Enquiry.findByIdAndUpdate(
    _id,
    { $set: fields },
    { new: true, runValidators: true, context: "query" }
  );
};

// Append a call-log entry (append-only stream — no edit/delete helpers by design).
// extraSet lets the caller atomically set fields in the same write (e.g. qualified: true).
const pushCallLogById = async (_id, entry, extraSet = {}) => {
  const update = { $push: { callLog: entry } };
  if (Object.keys(extraSet).length) update.$set = extraSet;
  return await Enquiry.findByIdAndUpdate(_id, update, {
    new: true,
    runValidators: true,
    context: "query",
  });
};

// Append a follow-up entry.
const pushFollowUpById = async (_id, entry) => {
  return await Enquiry.findByIdAndUpdate(
    _id,
    { $push: { followUps: entry } },
    { new: true, runValidators: true, context: "query" }
  );
};

// First-call TAT anchor (set-once, idempotent — same semantics as enquiry.SetFirstCall):
// `firstCalledAt: null` matches both null and missing, so only a never-called lead
// gets stamped; an already-stamped lead simply doesn't match and keeps its timestamp.
const stampFirstCalledAt = async (_id) => {
  return await Enquiry.findOneAndUpdate(
    { _id, firstCalledAt: null },
    { $set: { firstCalledAt: new Date() } },
    { new: true }
  );
};

// Signal Matrix Slice 7 — auto-complete DUE embedded CALL follow-ups when a
// call is actually logged, so a mission row can't stay red after the rep did
// the thing it asked for. Deliberately gate-exempt: the zero-orphan gate in
// completeFollowUp demands a next step a raw call log doesn't carry, and the
// cadence engine already suggests/schedules the next attempt on unanswered
// outcomes. Scoped tight: type "call" only, already due, still open.
const completeDueCallFollowUps = async (_id, actorId, outcome, now = new Date()) => {
  return await Enquiry.updateOne(
    { _id },
    {
      $set: {
        "followUps.$[f].completedAt": now,
        "followUps.$[f].completedBy": actorId || null,
        "followUps.$[f].completedOutcome": `auto:${outcome || "attempted"}`,
        "followUps.$[f].completedNotes": "Auto-completed by the logged call",
      },
    },
    {
      arrayFilters: [
        { "f.type": "call", "f.scheduledAt": { $lte: now }, "f.completedAt": null },
      ],
    }
  );
};

// Signal spine (Signal Matrix Slice 4) — any-channel first-response anchor.
// Same set-once semantics as stampFirstCalledAt: only a never-responded lead
// matches; later responses keep the original timestamp.
const stampFirstRespondedAt = async (_id, at) => {
  return await Enquiry.findOneAndUpdate(
    { _id, firstRespondedAt: null },
    { $set: { firstRespondedAt: at || new Date() } },
    { new: true }
  );
};

// Signal spine — monotonic "an employee did something" stamp. $max never moves
// the clock backwards, so out-of-order writers (backfill, retries) are safe.
const touchLastActivity = async (_id, at) => {
  return await Enquiry.findByIdAndUpdate(
    _id,
    { $max: { lastActivityAt: at || new Date() } },
    { new: true }
  );
};

module.exports = {
  findById,
  updateStageById,
  updateAssignedToById,
  updateFieldsById,
  claimByReassign,
  pushCallLogById,
  pushFollowUpById,
  stampFirstCalledAt,
  stampFirstRespondedAt,
  touchLastActivity,
  completeDueCallFollowUps,
};
