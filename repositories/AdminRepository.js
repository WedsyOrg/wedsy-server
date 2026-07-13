const Admin = require("../models/Admin");
const { assignableFilter } = require("../utils/assignable");

// Find an admin by _id. Returns the document or null.
const findById = async (_id) => {
  return await Admin.findById(_id);
};

// Find all admins. Excludes password field from response. Deliberately UNFILTERED
// (includes disabled/inactive): this backs the settings/users management list,
// which must show disabled admins so a founder can re-enable them. Assignability
// is enforced at the point of USE (assignableFilter), never here.
const findAll = async () => {
  return await Admin.find({}, { password: 0 }).sort({ name: 1 }).lean();
};

// Admins whose reportingManagerId is in the given set (one level). Used by team-scope BFS.
// Assignable-only: a disabled/inactive report neither carries nor grants scope, so it
// drops out of team-scope pools (its leads surface as orphans on the dashboard instead).
const findByReportingManagerIds = async (managerIds) => {
  return await Admin.find(
    assignableFilter({ reportingManagerId: { $in: managerIds } }),
    { _id: 1 }
  ).lean();
};

// Admin ids in a given department. Used by department-scope filter. Assignable-only
// for the same reason as the team-scope BFS above.
const findIdsByDepartment = async (departmentId) => {
  return await Admin.find(assignableFilter({ departmentId }), { _id: 1 }).lean();
};

module.exports = {
  findById,
  findAll,
  findByReportingManagerIds,
  findIdsByDepartment,
};
