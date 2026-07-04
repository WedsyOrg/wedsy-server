/**
 * MB10 Org & Access — the read layer over the EXISTING live RBAC (Role/Department/
 * Admin + requirePermission). This service ONLY reads + shapes; it adds NO new RBAC
 * vocabulary and flips NO enforcement. Two views:
 *   - chart(): the reporting tree from Admin.reportingManagerId, department-grouped,
 *     multi-hat aware (primary hat = top-level dept/role/manager; secondary hats
 *     carried in Admin.hats[] render as dotted secondary reporting edges).
 *   - permissionMatrix(): roles × (resource:action) cells, each = the broadest scope
 *     the role grants (parsed from its stored permissions[]). Founder-row visibility
 *     + locking reuse RoleService.getAll (no duplicated policy).
 */
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");
const RoleService = require("./RoleService");
const { RESOURCES, ACTIONS, SCOPES } = require("../utils/rbacPermissions");
const { parsePermission, SCOPE_RANK } = require("../middlewares/requirePermission");

// The (department, role, manager) hats a person carries. Always at least the
// primary hat, reconstructed from the live top-level fields for back-compat with
// any admin created before MB10 (no hats[] array yet).
const hatsOf = (admin) => {
  if (Array.isArray(admin.hats) && admin.hats.length) return admin.hats;
  return [
    {
      departmentId: admin.departmentId || null,
      roleId: admin.roleId || (Array.isArray(admin.roleIds) && admin.roleIds[0]) || null,
      reportingManagerId: admin.reportingManagerId || null,
    },
  ];
};

// GET /org/chart — the org tree. Active admins only (status !== inactive, not disabled).
const chart = async () => {
  const [admins, roles, departments] = await Promise.all([
    Admin.find({ isDisabled: { $ne: true } })
      .select("name email roleId roleIds departmentId reportingManagerId hats status meta")
      .lean(),
    Role.find({ deletedAt: null }).select("name departmentId").lean(),
    Department.find({ deletedAt: null }).select("name").lean(),
  ]);

  const roleName = new Map(roles.map((r) => [String(r._id), r.name]));
  const deptName = new Map(departments.map((d) => [String(d._id), d.name]));

  const nodes = admins.map((a) => {
    const hats = hatsOf(a).map((h) => ({
      departmentId: h.departmentId ? String(h.departmentId) : null,
      department: h.departmentId ? deptName.get(String(h.departmentId)) || null : null,
      roleId: h.roleId ? String(h.roleId) : null,
      role: h.roleId ? roleName.get(String(h.roleId)) || null : null,
      reportingManagerId: h.reportingManagerId ? String(h.reportingManagerId) : null,
    }));
    return {
      _id: String(a._id),
      name: a.name,
      email: a.email,
      status: a.status,
      designation: (a.meta && a.meta.designation) || "",
      // Primary hat drives the solid reporting line + department grouping (this IS
      // the live scope-resolution anchor — unchanged).
      primary: hats[0],
      // Any extra hats render as dotted secondary reporting edges.
      secondaryHats: hats.slice(1),
      hatCount: hats.length,
    };
  });

  // Department buckets keyed by each node's PRIMARY department (live grouping).
  const byDept = departments.map((d) => ({
    departmentId: String(d._id),
    department: d.name,
    members: nodes.filter((n) => n.primary.departmentId === String(d._id)),
  }));
  const unassigned = nodes.filter((n) => !n.primary.departmentId);
  if (unassigned.length) {
    byDept.push({ departmentId: null, department: "Unassigned", members: unassigned });
  }

  // Edges: solid = primary reporting line; dotted = each secondary hat's manager.
  const edges = [];
  for (const n of nodes) {
    if (n.primary.reportingManagerId) {
      edges.push({ from: n._id, to: n.primary.reportingManagerId, type: "primary" });
    }
    for (const h of n.secondaryHats) {
      if (h.reportingManagerId) {
        edges.push({ from: n._id, to: h.reportingManagerId, type: "secondary" });
      }
    }
  }

  return { nodes, departments: byDept, edges, total: nodes.length };
};

// GET /org/permission-matrix — roles × (resource:action), each cell = the broadest
// scope the role grants for that pair (or "none"). Wildcards expand: a role holding
// `*:*:all` (founder) reads as "all" everywhere. Edits go through PUT /role/:id —
// this endpoint is READ-ONLY.
const permissionMatrix = async (callerId) => {
  // Reuse RoleService.getAll so founder-row visibility + locked:true are identical
  // to the Roles settings screen (no duplicated policy).
  const roles = await RoleService.getAll(callerId);

  // The scope a granted permission set confers on one resource:action pair.
  const scopeFor = (perms, resource, action) => {
    let bestRank = -1;
    for (const p of perms || []) {
      const gp = parsePermission(p);
      const resourceMatch = gp.resource === "*" || gp.resource === resource;
      const actionMatch = gp.action === "*" || gp.action === action;
      if (!resourceMatch || !actionMatch) continue;
      const r = SCOPE_RANK[gp.scope];
      if (r === undefined) continue;
      if (r > bestRank) bestRank = r;
    }
    if (bestRank < 0) return "none";
    return Object.keys(SCOPE_RANK).find((k) => SCOPE_RANK[k] === bestRank);
  };

  const rows = roles.map((role) => {
    const cells = {};
    for (const resource of RESOURCES) {
      for (const action of ACTIONS) {
        const scope = scopeFor(role.permissions, resource, action);
        if (scope !== "none") cells[`${resource}:${action}`] = scope;
      }
    }
    return {
      _id: String(role._id),
      name: role.name,
      departmentId: role.departmentId ? String(role.departmentId) : null,
      description: role.description || "",
      protected: role.protected === true,
      systemKey: role.systemKey || "",
      // RoleService stamps locked:true on the founder row for founder callers.
      locked: role.locked === true || RoleService.isFounderRole(role),
      cells,
    };
  });

  return {
    resources: RESOURCES,
    actions: ACTIONS,
    scopes: ["none", ...SCOPES], // none → own → team → department → all
    roles: rows,
  };
};

module.exports = { chart, permissionMatrix, hatsOf };
