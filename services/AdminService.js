const AdminRepository = require("../repositories/AdminRepository");
const RoleRepository = require("../repositories/RoleRepository");
const Admin = require("../models/Admin");
const { permissionSatisfies } = require("../middlewares/requirePermission");
const { assignableFilter } = require("../utils/assignable");

// Scope-aware admin list (Lifecycle Slice H — the careful redo of the reverted gate).
// The route stays CheckAdminLogin-only so legitimate pages never 403; what the
// caller SEES is decided here:
//   users:view:all        → full list (minus password)
//   users:view:department → own department's admins (minus password)
//   anything else         → ACTIVE admins as a minimal projection
//                           { _id, name, roleId, departmentId } — enough for
//                           assignee dropdowns, no emails/phones/status leakage.
// assignableOnly: when true, EVERY tier is narrowed to admins who can receive
// work (assignableFilter — active + not disabled). Assignee dropdowns pass this
// (via GET /admin?assignable=true) so a disabled admin can never be picked. The
// DEFAULT (false) preserves the full roster for the settings/users management
// list, which must still show disabled admins so a founder can re-enable them.
const listAdmins = async (callerId, { assignableOnly = false } = {}) => {
  const caller = callerId ? await AdminRepository.findById(callerId) : null;
  // RBAC v2: union of permissions across all of the caller's roles.
  const { permissionsForAdmin } = require("../middlewares/requirePermission");
  const perms = await permissionsForAdmin(caller);

  // When narrowing to assignable admins, gate on isDisabled too; otherwise base
  // is the unfiltered management view.
  const gate = (extra = {}) => (assignableOnly ? assignableFilter(extra) : extra);

  if (permissionSatisfies(perms, "users:view:all").allowed) {
    if (!assignableOnly) return await AdminRepository.findAll();
    return await Admin.find(assignableFilter(), { password: 0 })
      .sort({ name: 1 })
      .lean();
  }
  if (
    permissionSatisfies(perms, "users:view:department").allowed &&
    caller &&
    caller.departmentId
  ) {
    return await Admin.find(
      gate({ departmentId: caller.departmentId }),
      { password: 0 }
    )
      .sort({ name: 1 })
      .lean();
  }
  // Minimal projection (no isDisabled field to filter client-side), so this tier
  // ALWAYS excludes disabled admins regardless of the flag — it only ever backs
  // dropdowns.
  return await Admin.find(
    assignableFilter(),
    { _id: 1, name: 1, roleId: 1, departmentId: 1 }
  )
    .sort({ name: 1 })
    .lean();
};

module.exports = {
  listAdmins,
};
