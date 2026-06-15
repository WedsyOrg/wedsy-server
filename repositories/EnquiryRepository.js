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

module.exports = {
  findById,
  updateStageById,
  updateAssignedToById,
  updateFieldsById,
  claimByReassign,
  pushCallLogById,
  pushFollowUpById,
  stampFirstCalledAt,
};
