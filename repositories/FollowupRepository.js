const Followup = require("../models/Followup");

const create = async (fields) => Followup.create(fields);
const findById = async (id) => Followup.findById(id);
const findByLead = async (leadId) => Followup.find({ leadId }).sort({ dueAt: 1 }).lean();
const findByLeadIds = async (leadIds) => Followup.find({ leadId: { $in: leadIds } }).lean();

// Caller's open/snoozed follow-ups due on or before `before`.
const findMineDue = async (ownerId, before) =>
  Followup.find({ ownerId, status: { $in: ["open", "snoozed"] }, dueAt: { $lte: before } }).sort({ dueAt: 1 }).lean();

// Newly-due, never-carded follow-ups for a lead (the once-only "due" chat card).
const findDueUncarded = async (leadId, now) =>
  Followup.find({ leadId, status: "open", dueAt: { $lte: now }, dueCardPostedAt: null }).lean();

const updateById = async (id, update) =>
  Followup.findByIdAndUpdate(id, update, { new: true, runValidators: true }).lean();

module.exports = { create, findById, findByLead, findByLeadIds, findMineDue, findDueUncarded, updateById };
