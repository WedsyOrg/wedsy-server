const LeadStep = require("../models/LeadStep");

const findByLead = async (leadId) => LeadStep.find({ leadId }).sort({ order: 1 }).lean();

const countByLead = async (leadId) => LeadStep.countDocuments({ leadId });

const findById = async (id) => LeadStep.findById(id);

const findByIdLean = async (id) => LeadStep.findById(id).lean();

const insertMany = async (rows) => LeadStep.insertMany(rows);

const updateById = async (id, update) =>
  LeadStep.findByIdAndUpdate(id, update, { new: true, runValidators: true }).lean();

module.exports = { findByLead, countByLead, findById, findByIdLean, insertMany, updateById };
