/**
 * MB10 Slice 3 — multi-hat people helpers shared by POST /admin + PUT /admin/:id.
 * Permissions live on ROLES (never per-person). A person carries one or more
 * (department, role, manager) HATS:
 *   - hats[0] = PRIMARY → mirrors the live top-level departmentId/roleId/
 *     reportingManagerId (the authoritative scope-resolution anchor — unchanged).
 *   - roleIds[] = the UNION of every hat's role (the existing permission union the
 *     gate already reads). Single-roleId resolution still works (roleIds falls
 *     back to roleId when empty).
 * Guardrails: every dept/role/manager must exist; reporting cycles are rejected
 * (transitive A→B→A); only a founder may assign the Founder role (incl. to self).
 */
const mongoose = require("mongoose");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");
const RoleService = require("./RoleService");
const { roleIdsOf } = require("../middlewares/requirePermission");

const err = (status, message) => Object.assign(new Error(message), { status });
const isId = (v) => mongoose.isValidObjectId(v);

// Accept either the simple single-hat body (roleId/departmentId/reportingManagerId)
// or an explicit hats[] array. Always returns a non-empty hats[] (primary first).
const normalizeHats = (body = {}) => {
  let hats = Array.isArray(body.hats) && body.hats.length
    ? body.hats
    : [{ departmentId: body.departmentId, roleId: body.roleId, reportingManagerId: body.reportingManagerId }];
  hats = hats
    .map((h) => ({
      departmentId: h.departmentId || null,
      roleId: h.roleId || null,
      reportingManagerId: h.reportingManagerId || h.reportingManagerId === null ? h.reportingManagerId || null : null,
    }))
    // A hat is meaningful only with a department + role.
    .filter((h) => h.departmentId || h.roleId);
  return hats;
};

// Validate hat shape + referential integrity. Returns the resolved
// { hats, roleIds, primary } or throws err(status,...).
const resolveHats = async (rawHats) => {
  if (!rawHats.length) throw err(400, "At least one (department, role) hat is required.");
  const hats = [];
  const roleIdSet = new Set();
  for (const h of rawHats) {
    if (!isId(h.departmentId) || !isId(h.roleId)) {
      throw err(400, "Each hat needs a valid departmentId and roleId.");
    }
    if (h.reportingManagerId && !isId(h.reportingManagerId)) {
      throw err(400, "Invalid reportingManagerId in a hat.");
    }
    const [role, dept] = await Promise.all([
      Role.findOne({ _id: h.roleId, deletedAt: null }).lean(),
      Department.findOne({ _id: h.departmentId, deletedAt: null }).lean(),
    ]);
    if (!role) throw err(400, "roleId does not match any role.");
    if (!dept) throw err(400, "departmentId does not match any department.");
    let managerId = null;
    if (h.reportingManagerId) {
      const manager = await Admin.findById(h.reportingManagerId).lean();
      if (!manager) throw err(400, "reportingManagerId does not match any user.");
      managerId = manager._id;
    }
    hats.push({ departmentId: dept._id, roleId: role._id, reportingManagerId: managerId });
    roleIdSet.add(String(role._id));
  }
  return { hats, roleIds: [...roleIdSet], primary: hats[0] };
};

// Only a founder caller may assign the Founder role (systemKey "founder" / *:*:all)
// to anyone — incl. themselves (blocks self-elevation to Founder).
const assertNotGrantingFounder = async (roleIds, callerId) => {
  const roles = await Role.find({ _id: { $in: roleIds } }).lean();
  const grantsFounder = roles.some((r) => RoleService.isFounderRole(r));
  if (!grantsFounder) return;
  const caller = await Admin.findById(callerId).lean();
  const callerRoles = caller ? await Role.find({ _id: { $in: roleIdsOf(caller) } }).lean() : [];
  const callerIsFounder = callerRoles.some((r) => RoleService.isFounderRole(r));
  if (!callerIsFounder) throw err(403, "Only a founder can assign the Founder role.");
};

// Reject a transitive reporting cycle: walking UP from each hat's manager via
// reportingManagerId must never reach targetId. (On create, targetId is null and
// no one reports to the new person yet, so a cycle is impossible — still cheap to
// guard.) Cycle-safe against pre-existing loops via a visited set.
const assertNoReportingCycle = async (targetId, hats) => {
  if (!targetId) return;
  const target = String(targetId);
  for (const h of hats) {
    let cursor = h.reportingManagerId ? String(h.reportingManagerId) : null;
    if (cursor === target) throw err(400, "A user cannot report to themselves.");
    const visited = new Set();
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      const mgr = await Admin.findById(cursor).select("reportingManagerId").lean();
      const next = mgr && mgr.reportingManagerId ? String(mgr.reportingManagerId) : null;
      if (next === target) {
        throw err(400, "Reporting cycle detected: that manager (directly or indirectly) reports to this user.");
      }
      cursor = next;
    }
  }
};

// Build the Admin field patch from resolved hats. Mirrors the primary hat into the
// authoritative top-level fields (unchanged live resolution) and sets roleIds union.
const fieldsFromHats = ({ hats, roleIds, primary }) => ({
  hats,
  roleIds,
  roleId: primary.roleId,
  departmentId: primary.departmentId,
  reportingManagerId: primary.reportingManagerId,
});

module.exports = {
  normalizeHats,
  resolveHats,
  assertNotGrantingFounder,
  assertNoReportingCycle,
  fieldsFromHats,
};
