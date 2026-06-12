const mongoose = require("mongoose");
const AdminService = require("../services/AdminService");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");
const { CreateHash } = require("../utils/password");

// Legacy roles[] kept in sync with the RBAC role's department so legacy gates
// stay consistent (schema enum: owner|crm|sales|ops|finance).
const LEGACY_ROLES_BY_DEPARTMENT = {
  Founders: ["owner"],
  Sales: ["sales"],
  "Client Servicing": ["crm"],
  Operations: ["ops"],
};
const deriveLegacyRoles = (departmentName) =>
  LEGACY_ROLES_BY_DEPARTMENT[departmentName] || ["crm"];

const STATUS_VALUES = ["active", "inactive", "on_leave"];

// Legacy roles for a role doc, via its department's name.
const legacyRolesForRole = async (role) => {
  const dept = await Department.findById(role.departmentId).lean();
  return deriveLegacyRoles(dept ? dept.name : "");
};

// GET /admin — scope-aware INSIDE the service (Slice H): full list for
// users:view:all, department list for users:view:department, otherwise a
// minimal active-admin projection so assignee dropdowns keep working.
// The route deliberately stays CheckAdminLogin-only (no 403 for normal pages).
const GetAll = async (req, res) => {
  try {
    const admins = await AdminService.listAdmins(req.auth.user_id);
    res.status(200).json(admins);
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

// POST /admin — founder-gated via users:create:all
const CreateAdmin = async (req, res) => {
  try {
    const { name, email, password, roleId, departmentId, reportingManagerId } =
      req.body || {};

    if (!name || !email || !password || !roleId || !departmentId) {
      return res.status(400).json({
        message: "name, email, password, roleId, and departmentId are required.",
      });
    }
    if (
      !mongoose.isValidObjectId(roleId) ||
      !mongoose.isValidObjectId(departmentId) ||
      (reportingManagerId && !mongoose.isValidObjectId(reportingManagerId))
    ) {
      return res.status(400).json({ message: "Invalid id format." });
    }

    const existing = await Admin.findOne({ email: String(email).trim() });
    if (existing) {
      return res
        .status(409)
        .json({ message: "An account with this email already exists." });
    }

    const role = await Role.findById(roleId).lean();
    if (!role) {
      return res.status(400).json({ message: "roleId does not match any role." });
    }
    const department = await Department.findById(departmentId).lean();
    if (!department) {
      return res
        .status(400)
        .json({ message: "departmentId does not match any department." });
    }

    let managerId = null;
    if (reportingManagerId) {
      const manager = await Admin.findById(reportingManagerId).lean();
      if (!manager) {
        return res
          .status(400)
          .json({ message: "reportingManagerId does not match any user." });
      }
      managerId = manager._id;
    }

    const hashed = await CreateHash(password);
    const created = await Admin.create({
      name: String(name).trim(),
      email: String(email).trim(),
      phone: "PENDING",
      password: hashed,
      roles: await legacyRolesForRole(role),
      roleId,
      departmentId,
      reportingManagerId: managerId,
      status: "active",
    });

    // Invite email (Lifecycle Slice G — ships dark until the template id exists).
    // Deliberately sends ONLY {name, email, loginUrl}: the password the founder
    // typed is NEVER emailed; the founder shares it separately.
    if (process.env.MAILJET_TEMPLATE_INVITE) {
      const NotificationService = require("../services/NotificationService");
      const loginUrl = `${process.env.OS_FRONTEND_URL || "https://os.wedsy.in"}/login`;
      NotificationService.sendEmail(
        created.email,
        Number(process.env.MAILJET_TEMPLATE_INVITE),
        { name: created.name, email: created.email, loginUrl },
        created.name
      ).catch((e) => console.error("[admin] invite email failed:", e.message));
    } else {
      console.warn("[admin] MAILJET_TEMPLATE_INVITE not set — invite email skipped (dark ship).");
    }

    const safe = created.toObject();
    delete safe.password;
    return res.status(201).json(safe);
  } catch (error) {
    return res.status(500).json({ message: "Server error" });
  }
};

// PUT /admin/:id — founder-gated via users:edit:all.
// Whitelisted fields only: roleId, departmentId, reportingManagerId, status, phone.
// Never updates password/email here.
const UpdateAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid id format." });
    }
    const target = await Admin.findById(id).lean();
    if (!target) {
      return res.status(404).json({ message: "User not found." });
    }

    const body = req.body || {};
    const update = {};

    // Lifecycle Slice I: phone is editable (fixes the seeded "PENDING" phones).
    if (body.phone !== undefined) {
      if (typeof body.phone !== "string" || !body.phone.trim()) {
        return res.status(400).json({ message: "phone must be a non-empty string." });
      }
      update.phone = body.phone.trim();
    }

    if (body.status !== undefined) {
      if (!STATUS_VALUES.includes(body.status)) {
        return res
          .status(400)
          .json({ message: "status must be one of: active, inactive, on_leave." });
      }
      update.status = body.status;
    }

    if (body.roleId !== undefined && body.roleId !== null) {
      if (!mongoose.isValidObjectId(body.roleId)) {
        return res.status(400).json({ message: "Invalid roleId format." });
      }
      const role = await Role.findById(body.roleId).lean();
      if (!role) {
        return res.status(400).json({ message: "roleId does not match any role." });
      }
      update.roleId = role._id;
      // Role changed → keep legacy roles[] consistent with the new role's department.
      if (String(role._id) !== String(target.roleId)) {
        update.roles = await legacyRolesForRole(role);
      }
    }

    if (body.departmentId !== undefined && body.departmentId !== null) {
      if (!mongoose.isValidObjectId(body.departmentId)) {
        return res.status(400).json({ message: "Invalid departmentId format." });
      }
      const department = await Department.findById(body.departmentId).lean();
      if (!department) {
        return res
          .status(400)
          .json({ message: "departmentId does not match any department." });
      }
      update.departmentId = department._id;
    }

    if (body.reportingManagerId !== undefined) {
      if (body.reportingManagerId === null || body.reportingManagerId === "") {
        update.reportingManagerId = null;
      } else {
        if (!mongoose.isValidObjectId(body.reportingManagerId)) {
          return res.status(400).json({ message: "Invalid reportingManagerId format." });
        }
        if (String(body.reportingManagerId) === String(target._id)) {
          return res
            .status(400)
            .json({ message: "A user cannot report to themselves." });
        }
        const manager = await Admin.findById(body.reportingManagerId).lean();
        if (!manager) {
          return res
            .status(400)
            .json({ message: "reportingManagerId does not match any user." });
        }
        update.reportingManagerId = manager._id;
      }
    }

    const updated = await Admin.findByIdAndUpdate(
      id,
      { $set: update },
      { new: true, runValidators: true, projection: { password: 0 } }
    ).lean();
    return res.status(200).json(updated);
  } catch (error) {
    return res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  GetAll,
  CreateAdmin,
  UpdateAdmin,
};
