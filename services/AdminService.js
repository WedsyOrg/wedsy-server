const AdminRepository = require("../repositories/AdminRepository");
const RoleRepository = require("../repositories/RoleRepository");
const Admin = require("../models/Admin");
const { permissionSatisfies } = require("../middlewares/requirePermission");

// Scope-aware admin list (Lifecycle Slice H — the careful redo of the reverted gate).
// The route stays CheckAdminLogin-only so legitimate pages never 403; what the
// caller SEES is decided here:
//   users:view:all        → full list (minus password)
//   users:view:department → own department's admins (minus password)
//   anything else         → ACTIVE admins as a minimal projection
//                           { _id, name, roleId, departmentId } — enough for
//                           assignee dropdowns, no emails/phones/status leakage.
const listAdmins = async (callerId) => {
  const caller = callerId ? await AdminRepository.findById(callerId) : null;
  // RBAC v2: union of permissions across all of the caller's roles.
  const { permissionsForAdmin } = require("../middlewares/requirePermission");
  const perms = await permissionsForAdmin(caller);

  if (permissionSatisfies(perms, "users:view:all").allowed) {
    return await AdminRepository.findAll();
  }
  if (
    permissionSatisfies(perms, "users:view:department").allowed &&
    caller &&
    caller.departmentId
  ) {
    return await Admin.find(
      { departmentId: caller.departmentId },
      { password: 0 }
    )
      .sort({ name: 1 })
      .lean();
  }
  return await Admin.find(
    { status: "active" },
    { _id: 1, name: 1, roleId: 1, departmentId: 1 }
  )
    .sort({ name: 1 })
    .lean();
};

module.exports = {
  listAdmins,
};
