/**
 * READ-ONLY prod audit. Safe to run on EC2. Performs no writes.
 *
 * Verifies the Admin RBAC migration: which Admins carry the new `roleId`
 * (migrated) vs. only the legacy `roles[]` array (at-risk under live RBAC
 * enforcement). Uses ONLY read operations — find/countDocuments — with .lean()
 * so no mutable model instances are ever created. No save/update/insert/delete,
 * no bulkWrite, no findOneAndUpdate, no temporary links, no revert logic,
 * no process mutations.
 */

require("dotenv").config();
const mongoose = require("mongoose");

const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");

// Mask the local part of an email so the audit log doesn't dump raw PII.
function maskEmail(email) {
  if (!email || typeof email !== "string" || !email.includes("@")) return "—";
  const [local, domain] = email.split("@");
  if (!local) return `*@${domain}`;
  if (local.length <= 1) return `*@${domain}`;
  return `${local[0]}${"*".repeat(local.length - 1)}@${domain}`;
}

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL);
    console.log("Connected — READ-ONLY audit. No writes will be performed.\n");

    // ---- Admin migration summary ----
    const totalAdmins = await Admin.countDocuments({});
    // $ne: null matches only docs where roleId is present AND not null
    // (a missing field is treated as null, so it is excluded here).
    const withRoleId = await Admin.countDocuments({ roleId: { $ne: null } });
    const withoutRoleId = totalAdmins - withRoleId;

    console.log("=== Admin migration summary ===");
    console.log(`Total admins:             ${totalAdmins}`);
    console.log(`With roleId (migrated):   ${withRoleId}`);
    console.log(`Without roleId (legacy):  ${withoutRoleId}`);
    console.log("");

    // ---- Build a read-only Role lookup table ----
    const roles = await Role.find({}).lean();
    const roleById = new Map(roles.map((r) => [String(r._id), r]));

    // ---- Per-admin detail ----
    const admins = await Admin.find({}).lean();
    console.log("=== Per-admin detail ===");
    admins.forEach((a) => {
      const hasRoleId = a.roleId != null;
      const legacyRoles = Array.isArray(a.roles) ? a.roles : [];

      let resolvedRole = "—";
      let permCount = "—";
      if (hasRoleId) {
        const role = roleById.get(String(a.roleId));
        if (role) {
          resolvedRole = role.name;
          permCount = Array.isArray(role.permissions)
            ? role.permissions.length
            : 0;
        } else {
          resolvedRole = "(roleId set but Role not found)";
          permCount = 0;
        }
      }

      console.log(
        `- ${a.name || "(no name)"} <${maskEmail(a.email)}>` +
          ` | legacy roles: [${legacyRoles.join(", ")}]` +
          ` | roleId: ${hasRoleId ? "SET" : "MISSING"}` +
          ` | role: ${resolvedRole}` +
          ` | permissions: ${permCount}`
      );
    });
    console.log("");

    // ---- At-risk set: admins missing roleId ----
    const missing = admins.filter((a) => a.roleId == null);
    console.log("=== At-risk under live enforcement (missing roleId) ===");
    if (missing.length === 0) {
      console.log("None — every admin has a roleId.");
    } else {
      missing.forEach((a) => {
        const legacyRoles = Array.isArray(a.roles) ? a.roles : [];
        console.log(
          `- ${a.name || "(no name)"} <${maskEmail(a.email)}>` +
            ` | legacy roles: [${legacyRoles.join(", ")}]`
        );
      });
      console.log(`(${missing.length} admin(s) would be blocked by RBAC.)`);
    }
    console.log("");

    // ---- RBAC inventory ----
    const totalRoles = await Role.countDocuments({});
    const totalDepartments = await Department.countDocuments({});

    console.log("=== RBAC inventory ===");
    console.log(`Total roles:       ${totalRoles}`);
    console.log(`Total departments: ${totalDepartments}`);
    console.log("Role names:");
    roles
      .slice()
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .forEach((r) =>
        console.log(`  - ${r.name}${r.deletedAt ? " (soft-deleted)" : ""}`)
      );
  } catch (err) {
    console.error("Audit failed:", err);
  } finally {
    await mongoose.disconnect();
    console.log("\nDisconnected.");
  }
})();
