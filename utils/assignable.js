const Admin = require("../models/Admin");

// ─────────────────────────────────────────────────────────────────────────────
// ONE source of truth for "can this admin receive work / be a live work target."
//
// Two independent fields gate an admin:
//   • status  — HR state (active | inactive | on_leave)
//   • isDisabled — access control (the Disable button; login + tokens revoked)
// The Disable button writes ONLY isDisabled and leaves status "active", so any
// selector that filters status alone silently keeps disabled admins in its pool.
// Every assignment/pool/notification-target selector MUST go through this
// predicate so the two systems can never diverge again.
// ─────────────────────────────────────────────────────────────────────────────

// Mongo filter for assignable admins. Spread `extra` to narrow by role,
// department, _id $in, etc. — e.g. assignableFilter({ roleId }).
const assignableFilter = (extra = {}) => ({
  status: "active",
  isDisabled: { $ne: true },
  ...extra,
});

// Query assignable admins. `extra` narrows the set; `projection` is optional.
// Returns a Mongoose query (await it, chain .sort()/.lean() as needed).
const findAssignable = (extra = {}, projection = undefined) =>
  Admin.find(assignableFilter(extra), projection);

// Given candidate ids, return the subset that is currently assignable.
// Handy for notification/recipient sets already resolved to ids.
const filterAssignableIds = async (ids = []) => {
  const list = (ids || []).filter(Boolean);
  if (!list.length) return [];
  const rows = await findAssignable({ _id: { $in: list } }, { _id: 1 }).lean();
  return rows.map((r) => r._id);
};

// Is a single admin id assignable right now? Write-side guard for assign/transfer.
const isAssignableAdmin = async (id) => {
  if (!id) return false;
  const found = await findAssignable({ _id: id }, { _id: 1 }).lean();
  return Array.isArray(found) ? found.length > 0 : !!found;
};

module.exports = {
  assignableFilter,
  findAssignable,
  filterAssignableIds,
  isAssignableAdmin,
};
