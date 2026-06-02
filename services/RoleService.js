const mongoose = require("mongoose");
const RoleRepository = require("../repositories/RoleRepository");
const { validatePermissions } = require("../utils/rbacPermissions");

const err = (status, message) => Object.assign(new Error(message), { status });

const getAll = async () => {
  return await RoleRepository.findAllActive();
};

// Update a role's permissions (and optionally description). Permissions-only:
// name / departmentId / isSystem are never changed here. Protected roles cannot be edited.
const updatePermissions = async (_id, { permissions, description } = {}) => {
  if (!mongoose.Types.ObjectId.isValid(_id)) {
    throw err(400, "Invalid role id.");
  }
  const role = await RoleRepository.findById(_id);
  if (!role || role.deletedAt) {
    throw err(404, "Role not found.");
  }
  if (role.protected === true) {
    throw err(403, "This role is protected and cannot be edited.");
  }
  const { valid, errors } = validatePermissions(permissions);
  if (!valid) {
    throw err(400, `Invalid permissions: ${errors.join("; ")}`);
  }
  const fields = { permissions: [...new Set(permissions)] };
  if (typeof description === "string") {
    fields.description = description;
  }
  return await RoleRepository.updateById(_id, fields);
};

module.exports = {
  getAll,
  updatePermissions,
};
