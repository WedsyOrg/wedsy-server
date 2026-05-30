const Admin = require("../models/Admin");

// Find an admin by _id. Returns the document or null.
const findById = async (_id) => {
  return await Admin.findById(_id);
};

// Find all admins. Excludes password field from response.
const findAll = async () => {
  return await Admin.find({}, { password: 0 }).sort({ name: 1 }).lean();
};

// Admins whose reportingManagerId is in the given set (one level). Used by team-scope BFS.
const findByReportingManagerIds = async (managerIds) => {
  return await Admin.find({ reportingManagerId: { $in: managerIds } }, { _id: 1 }).lean();
};

// Admin ids in a given department. Used by department-scope filter.
const findIdsByDepartment = async (departmentId) => {
  return await Admin.find({ departmentId }, { _id: 1 }).lean();
};

module.exports = {
  findById,
  findAll,
  findByReportingManagerIds,
  findIdsByDepartment,
};
