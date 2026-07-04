const AdminRepository = require("../repositories/AdminRepository");
const RoleRepository = require("../repositories/RoleRepository");

const SCOPE_RANK = { own: 0, team: 1, department: 2, all: 3 };

// team-traversal cache: adminId -> { ids:[], expires:ms }
const TEAM_CACHE_TTL_MS = 5 * 60 * 1000;
const teamCache = new Map();

const parsePermission = (str) => {
  const [resource, action, scope] = String(str).split(":");
  return { resource, action, scope };
};

// ── RBAC v2 (MB7a) — multi-role permission UNION ─────────────────────────────
// An admin's effective roles = roleIds[] when set, else the single roleId
// (backward-compatible). permissionsForAdmin returns the UNION of every role's
// permissions — the single source of truth used by the gate and every reader.
const roleIdsOf = (admin) => {
  if (admin && Array.isArray(admin.roleIds) && admin.roleIds.length) return admin.roleIds;
  if (admin && admin.roleId) return [admin.roleId];
  return [];
};

const permissionsForAdmin = async (admin) => {
  const ids = roleIdsOf(admin);
  if (!ids.length) return [];
  const roles = await RoleRepository.findByIds(ids);
  const set = new Set();
  for (const r of roles) for (const p of (r && r.permissions) || []) set.add(p);
  return [...set];
};

// Do the granted permission strings satisfy the required one?
// Wildcards (*) allowed on resource and action. Scope expands: all >= department >= team >= own.
// effectiveScope = broadest granted scope for the matched resource:action (used to build the filter).
const permissionSatisfies = (grantedPerms, requiredStr) => {
  const req = parsePermission(requiredStr);
  const requiredRank = SCOPE_RANK[req.scope];
  let bestRank = -1;

  for (const g of grantedPerms || []) {
    const gp = parsePermission(g);
    const resourceMatch = gp.resource === "*" || gp.resource === req.resource;
    const actionMatch = gp.action === "*" || gp.action === req.action;
    if (!resourceMatch || !actionMatch) continue;
    const gRank = SCOPE_RANK[gp.scope];
    if (gRank === undefined) continue;
    if (gRank > bestRank) bestRank = gRank;
  }

  if (bestRank < 0 || bestRank < requiredRank) return { allowed: false, effectiveScope: null };
  const effectiveScope = Object.keys(SCOPE_RANK).find((k) => SCOPE_RANK[k] === bestRank);
  return { allowed: true, effectiveScope };
};

// BFS over reportingManagerId -> all transitive subordinate ids. Cycle-safe. 5-min cached.
const getSubordinateIds = async (adminId) => {
  const key = String(adminId);
  const cached = teamCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.ids;

  const all = new Set();
  let frontier = [adminId];
  while (frontier.length) {
    const subs = await AdminRepository.findByReportingManagerIds(frontier);
    const newIds = [];
    for (const s of subs) {
      const id = String(s._id);
      if (id !== key && !all.has(id)) {
        all.add(id);
        newIds.push(s._id);
      }
    }
    if (!newIds.length) break;
    frontier = newIds;
  }
  const ids = [...all];
  teamCache.set(key, { ids, expires: Date.now() + TEAM_CACHE_TTL_MS });
  return ids;
};

const getDepartmentMemberIds = async (departmentId) => {
  if (!departmentId) return [];
  const members = await AdminRepository.findIdsByDepartment(departmentId);
  return members.map((m) => m._id);
};

// Mongo filter limiting records to the admin's scope. ownerField references the owning admin (e.g. "assignedTo").
const buildScopeFilter = async (scope, admin, ownerField) => {
  if (scope === "all" || !ownerField) return {};
  if (scope === "own") return { [ownerField]: admin._id };
  if (scope === "team") {
    const subs = await getSubordinateIds(admin._id);
    return { [ownerField]: { $in: [admin._id, ...subs] } };
  }
  if (scope === "department") {
    const members = await getDepartmentMemberIds(admin.departmentId);
    return { [ownerField]: { $in: members } };
  }
  return { [ownerField]: admin._id };
};

// Express middleware factory. MUST run after CheckAdminLogin (needs req.auth.user_id). Fail-closed.
const requirePermission = (requiredStr, options = {}) => {
  const ownerField = options.ownerField || null;
  return async (req, res, next) => {
    try {
      const adminId = req.auth && req.auth.user_id;
      if (!adminId) return res.status(403).json({ message: "Forbidden" });

      const admin = await AdminRepository.findById(adminId);
      if (!admin || roleIdsOf(admin).length === 0) return res.status(403).json({ message: "Forbidden" });

      // RBAC v2: union of permissions across all of the admin's roles.
      const perms = await permissionsForAdmin(admin);
      if (!perms.length) return res.status(403).json({ message: "Forbidden" });

      const { allowed, effectiveScope } = permissionSatisfies(perms, requiredStr);
      if (!allowed) return res.status(403).json({ message: "Forbidden", required: requiredStr });

      req.scope = effectiveScope;
      req.scopeFilter = await buildScopeFilter(effectiveScope, admin, ownerField);
      next();
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  };
};

module.exports = {
  requirePermission,
  parsePermission,
  permissionSatisfies,
  permissionsForAdmin,
  roleIdsOf,
  buildScopeFilter,
  getSubordinateIds,
  getDepartmentMemberIds,
  SCOPE_RANK,
  _teamCache: teamCache,
};
