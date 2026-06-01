const AdminRepository = require("../repositories/AdminRepository");
const RoleRepository = require("../repositories/RoleRepository");
const { permissionSatisfies } = require("../middlewares/requirePermission");

// Shared disqualification-approval eligibility helpers.
// Kept here (not in a controller) so both controllers/disqualify.js and the service layer
// can require them without a circular dependency (controller -> service -> controller).

// Walk UP the assigned admin's reportingManagerId chain and check whether `actorId`
// appears anywhere in it (i.e. is the assigned person's manager, transitively).
// Depth-capped and cycle-safe.
const isManagerOfAssigned = async (actorId, assignedToId) => {
  if (!actorId || !assignedToId) return false;
  let currentId = assignedToId;
  const seen = new Set();
  for (let depth = 0; depth < 10 && currentId; depth++) {
    const key = String(currentId);
    if (seen.has(key)) break;
    seen.add(key);
    const admin = await AdminRepository.findById(currentId);
    if (!admin || !admin.reportingManagerId) break;
    if (String(admin.reportingManagerId) === String(actorId)) return true;
    currentId = admin.reportingManagerId;
  }
  return false;
};

// Does this admin's role grant a leads:approve permission at any scope?
// (own is the lowest rank, so any leads:approve:* — or a broader wildcard — satisfies it.)
const actorHasApprovePermission = async (actorId) => {
  if (!actorId) return false;
  const admin = await AdminRepository.findById(actorId);
  if (!admin || !admin.roleId) return false;
  const role = await RoleRepository.findById(admin.roleId);
  if (!role || !Array.isArray(role.permissions)) return false;
  return permissionSatisfies(role.permissions, "leads:approve:own").allowed;
};

module.exports = {
  isManagerOfAssigned,
  actorHasApprovePermission,
};
