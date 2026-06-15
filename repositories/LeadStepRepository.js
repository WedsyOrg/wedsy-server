const LeadStep = require("../models/LeadStep");

const findByLead = async (leadId) => LeadStep.find({ leadId }).sort({ order: 1 }).lean();

const countByLead = async (leadId) => LeadStep.countDocuments({ leadId });

const findById = async (id) => LeadStep.findById(id);

const findByIdLean = async (id) => LeadStep.findById(id).lean();

const insertMany = async (rows) => LeadStep.insertMany(rows);

const updateById = async (id, update) =>
  LeadStep.findByIdAndUpdate(id, update, { new: true, runValidators: true }).lean();

// ── MB8c-1 cross-lead dashboard reads (indexed) ──────────────────────────────
// Steps the caller "works": owned by anyone in ownerIds OR on a roster lead.
const findByOwnerOrLead = async (ownerIds, leadIds) =>
  LeadStep.find({ $or: [{ ownerIds: { $in: ownerIds } }, { leadId: { $in: leadIds } }] }).lean();

// Every step (all-scope My Work). Bounded in practice by journey leads.
const findAllSteps = async () => LeadStep.find({}).lean();

// All steps for a set of leads (pipeline progress + blocked computation).
const findByLeadIds = async (leadIds) =>
  LeadStep.find({ leadId: { $in: leadIds } }).sort({ order: 1 }).lean();

module.exports = {
  findByLead,
  countByLead,
  findById,
  findByIdLean,
  insertMany,
  updateById,
  findByOwnerOrLead,
  findAllSteps,
  findByLeadIds,
};
