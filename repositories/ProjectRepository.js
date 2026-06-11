const Project = require("../models/Project");

const create = async (fields) => {
  return await Project.create(fields);
};

const findByLeadId = async (leadId) => {
  return await Project.findOne({ leadId }).lean();
};

// Scope-filtered list, newest first. scopeFilter is built by requirePermission
// with ownerField csOwnerId (own → only the caller's projects).
const findAll = async (scopeFilter = {}) => {
  return await Project.find(scopeFilter).sort({ createdAt: -1 }).lean();
};

module.exports = { create, findByLeadId, findAll };
