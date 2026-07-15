const mongoose = require("mongoose");
const RoleRepository = require("../repositories/RoleRepository");
const Role = require("../models/Role");
const Admin = require("../models/Admin");
const { validatePermissions } = require("../utils/rbacPermissions");
const { permissionSatisfies } = require("../middlewares/requirePermission");

const err = (status, message) => Object.assign(new Error(message), { status });

// ─── Founder-protection helpers (Settings Suite — hard requirement) ───────────
// The founder role is identified by systemKey "founder" (stamped by the seed) or,
// defensively, by holding *:*:all.
const isFounderRole = (role) =>
  role && (role.systemKey === "founder" || (role.permissions || []).includes("*:*:all"));

const callerContext = async (callerId) => {
  if (!callerId) return { admin: null, role: null, isFounder: false };
  const admin = await Admin.findById(callerId).lean();
  // RBAC v2: founder if ANY of the caller's roles is the founder role.
  const { roleIdsOf } = require("../middlewares/requirePermission");
  const ids = roleIdsOf(admin);
  const roles = ids.length ? await Role.find({ _id: { $in: ids } }).lean() : [];
  const founderRole = roles.find(isFounderRole) || null;
  return { admin, role: founderRole || roles[0] || null, isFounder: roles.some(isFounderRole) };
};

// Roles list: the founder role (and therefore its matrix row) is INVISIBLE to any
// caller who does not themselves hold it; for the founder it carries locked:true.
const getAll = async (callerId) => {
  const roles = await RoleRepository.findAllActive();
  const { isFounder } = await callerContext(callerId);
  return roles
    .filter((r) => isFounder || !isFounderRole(r))
    .map((r) => (isFounderRole(r) ? { ...r, locked: true } : r));
};

// Update a role's permissions (and optionally description).
// Server-enforced, NO exceptions (not even founder callers):
//   - the founder role is immutable (422)
//   - protected roles cannot be edited (403)
//   - callers cannot edit the role they themselves hold (403, self-elevation block)
//   - only the founder may grant *:*:all or any settings_roles permission (403)
const updatePermissions = async (_id, { permissions, description } = {}, callerId) => {
  if (!mongoose.Types.ObjectId.isValid(_id)) {
    throw err(400, "Invalid role id.");
  }
  const role = await RoleRepository.findById(_id);
  if (!role || role.deletedAt) {
    throw err(404, "Role not found.");
  }
  if (isFounderRole(role)) {
    throw err(422, "Founder role is immutable");
  }
  if (role.protected === true) {
    throw err(403, "This role is protected and cannot be edited.");
  }
  const { admin, isFounder } = await callerContext(callerId);
  const { roleIdsOf } = require("../middlewares/requirePermission");
  if (admin && roleIdsOf(admin).map(String).includes(String(_id))) {
    throw err(403, "You cannot edit a role you yourself hold.");
  }
  const { valid, errors } = validatePermissions(permissions);
  if (!valid) {
    throw err(400, `Invalid permissions: ${errors.join("; ")}`);
  }
  if (!isFounder) {
    const grantsForbidden = (permissions || []).some(
      (p) => p === "*:*:all" || p.startsWith("settings_roles:")
    );
    if (grantsForbidden) {
      throw err(403, "Only the founder can grant *:*:all or settings_roles permissions.");
    }
  }
  const fields = { permissions: [...new Set(permissions)] };
  if (typeof description === "string") {
    fields.description = description;
  }
  return await RoleRepository.updateById(_id, fields);
};

// Create a role: name (+ optional departmentId) cloning permissions from an
// existing role. Founder-role permissions can never be cloned.
const createRole = async ({ name, departmentId, cloneFromRoleId, description } = {}, callerId) => {
  if (typeof name !== "string" || !name.trim()) throw err(400, "name is required");
  const existing = await Role.findOne({ name: name.trim(), deletedAt: null }).lean();
  if (existing) throw err(409, "A role with this name already exists");

  let permissions = [];
  let dept = departmentId;
  if (cloneFromRoleId) {
    if (!mongoose.Types.ObjectId.isValid(cloneFromRoleId)) throw err(400, "Invalid cloneFromRoleId");
    const source = await Role.findById(cloneFromRoleId).lean();
    if (!source || source.deletedAt) throw err(404, "Clone-source role not found");
    if (isFounderRole(source)) throw err(422, "Founder role is immutable");
    permissions = [...source.permissions];
    dept = dept || source.departmentId;
  }
  if (!dept || !mongoose.Types.ObjectId.isValid(String(dept))) {
    throw err(400, "departmentId is required (or clone from a role that has one)");
  }
  const { isFounder } = await callerContext(callerId);
  if (!isFounder) {
    permissions = permissions.filter(
      (p) => p !== "*:*:all" && !p.startsWith("settings_roles:")
    );
  }
  return await Role.create({
    name: name.trim(),
    departmentId: dept,
    description: description || "",
    permissions,
    isSystem: false,
  });
};

// Delete (soft) a role — only when zero admins hold it; 422 listing holders otherwise.
const deleteRole = async (_id, callerId) => {
  if (!mongoose.Types.ObjectId.isValid(_id)) throw err(400, "Invalid role id.");
  const role = await RoleRepository.findById(_id);
  if (!role || role.deletedAt) throw err(404, "Role not found.");
  if (isFounderRole(role)) throw err(422, "Founder role is immutable");
  if (role.protected === true) throw err(403, "This role is protected and cannot be deleted.");
  const holders = await Admin.find({ $or: [{ roleId: _id }, { roleIds: _id }] }, { name: 1 }).lean();
  if (holders.length > 0) {
    throw err(
      422,
      `Cannot delete: ${holders.length} admin(s) hold this role (${holders.map((h) => h.name).join(", ")}). Reassign them first.`
    );
  }
  await Role.findByIdAndUpdate(_id, { $set: { deletedAt: new Date() } });
  return { deleted: String(_id) };
};

module.exports = {
  getAll,
  updatePermissions,
  createRole,
  deleteRole,
  isFounderRole,
  // W4/W5/W6 (additive) — caller role context (admin doc + founder fact),
  // reused by the workspace/escalations/team reads.
  callerContext,
};
