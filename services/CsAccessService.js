// C2 — CS WORKSPACE ACCESS. Who may enter /cs/*: client-servicing department
// membership (primary departmentId OR any hat), founder, Revenue Head, or a
// manager with CS members in their subordinate closure. The "manager view" is
// for managers-of-CS / RH / founder.
const Admin = require("../models/Admin");
const Department = require("../models/Department");
const Role = require("../models/Role");

const err = (status, message) => Object.assign(new Error(message), { status });

const csDepartment = async () => {
  // The dept-seed ensure guarantees the slug on any live DB.
  await require("./WorkspaceService").ensureDayOneDepartments();
  return await Department.findOne({ slug: "client_servicing", deletedAt: null }).lean();
};

// All admins wearing a CS hat (primary departmentId or hats[].departmentId).
const csMemberIds = async (csDeptId) => {
  if (!csDeptId) return [];
  const rows = await Admin.find(
    { $or: [{ departmentId: csDeptId }, { "hats.departmentId": csDeptId }] },
    { _id: 1 }
  ).lean();
  return rows.map((r) => r._id);
};

const csContext = async (callerId) => {
  const { callerContext } = require("./RoleService");
  const { roleIdsOf, getSubordinateIds } = require("../middlewares/requirePermission");
  const { admin, isFounder } = await callerContext(callerId);
  if (!admin) throw err(404, "Admin not found");
  const roles = roleIdsOf(admin).length
    ? await Role.find({ _id: { $in: roleIdsOf(admin) }, deletedAt: null }, { name: 1 }).lean()
    : [];
  const isRevenueHead = roles.some((r) => r.name === "Revenue Head");

  const dept = await csDepartment();
  const memberIds = await csMemberIds(dept && dept._id);
  const memberSet = new Set(memberIds.map(String));
  const isCsMember =
    memberSet.has(String(admin._id)) ||
    String(admin.departmentId || "") === String((dept && dept._id) || "x") ||
    (admin.hats || []).some((h) => String(h.departmentId || "") === String((dept && dept._id) || "x"));

  let managesCs = false;
  if (!isFounder && !isRevenueHead) {
    const subs = (await getSubordinateIds(admin._id)).map(String);
    managesCs = subs.some((s) => memberSet.has(s));
  }
  const isManagerView = isFounder || isRevenueHead || managesCs;

  if (!isCsMember && !isManagerView) throw err(403, "The CS workspace is for Client Servicing members and their managers.");

  return { admin, dept, memberIds, isCsMember, isFounder, isRevenueHead, isManagerView };
};

// Express gate — stashes the context for the controller.
const requireCs = async (req, res, next) => {
  try {
    req.csContext = await csContext(req.auth.user_id);
    next();
  } catch (error) {
    res.status(error.status || 500).json({ message: error.status ? error.message : "Could not resolve CS access." });
  }
};

module.exports = { csContext, requireCs, csDepartment, csMemberIds };
