/**
 * RBAC — Local hierarchy seed (TEST TOOLING, LOCAL DEV DB ONLY)
 *
 * Idempotently upserts the test admins that form a reporting chain so the
 * enforcement harness can assert TEAM-scope filtering on the lead READ routes:
 *
 *   test-founder@local.test      -> Founder / Founders     (top of chain)
 *   test-revenuehead@local.test  -> Revenue Head / Sales    reports to founder
 *   test-salesmgr@local.test     -> Sales Manager / Sales    reports to revenuehead
 *   test-salesexec@local.test    -> Sales Executive / Sales  reports to salesmgr
 *
 * All get password "LocalTest123!" (bcrypt-hashed via utils/password, what
 * POST /auth/admin -> AdminLogin validates against) and status "active", so
 * they can log in and receive a JWT.
 *
 * Requires the role/department seed to have run first
 * (scripts/rbac-phase-2b-seed-roles.js): roles are looked up by name and if
 * "Revenue Head" or "Sales Manager" is missing this aborts non-zero.
 *
 * Idempotent: admins are matched by email and upserted; the reporting chain is
 * (re)wired every run, so re-runs converge without duplicating.
 *
 * LOCAL DEV DB ONLY — aborts if DATABASE_URL is not localhost.
 *
 * Run: node scripts/rbac-local-seed-hierarchy.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");
const { CreateHash } = require("../utils/password");

// --- HARD PROD GUARD: this script must never touch prod ---
const dbUrl = process.env.DATABASE_URL || "";
if (!dbUrl.startsWith("mongodb://localhost")) {
  console.error("ABORT: DATABASE_URL is not a localhost URI. This seed runs on the local dev DB only.");
  console.error(`DATABASE_URL = ${dbUrl || "(empty)"}`);
  process.exit(1);
}

const PASSWORD = "LocalTest123!";

// Test admins to seed/wire. `legacyRoles` satisfies the required legacy Admin.roles[]
// enum; roleId/departmentId come from the looked-up RBAC role. `reportsTo` is the
// email of the admin this one reports to (resolved to reportingManagerId after upsert).
const TEST_ADMINS = [
  {
    name: "Test Founder",
    email: "test-founder@local.test",
    phone: "0000000001",
    roleName: "Founder",
    legacyRoles: ["owner"],
    reportsTo: null,
  },
  {
    name: "Test Revenue Head",
    email: "test-revenuehead@local.test",
    phone: "0000000003",
    roleName: "Revenue Head",
    legacyRoles: ["sales"],
    reportsTo: "test-founder@local.test",
  },
  {
    name: "Test Sales Manager",
    email: "test-salesmgr@local.test",
    phone: "0000000004",
    roleName: "Sales Manager",
    legacyRoles: ["sales"],
    reportsTo: "test-revenuehead@local.test",
  },
  {
    name: "Test Sales Executive",
    email: "test-salesexec@local.test",
    phone: "0000000002",
    roleName: "Sales Executive",
    legacyRoles: ["sales"],
    reportsTo: "test-salesmgr@local.test",
  },
];

(async () => {
  try {
    await mongoose.connect(dbUrl);
    console.log(`Connected to ${dbUrl}`);

    // Roles must already be seeded. Guard explicitly on the two named in the spec.
    for (const roleName of ["Revenue Head", "Sales Manager"]) {
      const role = await Role.findOne({ name: roleName, deletedAt: null });
      if (!role) {
        console.error(`ABORT: role not found: "${roleName}". run the local role seed first`);
        process.exitCode = 1;
        return;
      }
    }

    // Resolve and validate all required roles up front; abort if any missing.
    const resolved = [];
    for (const a of TEST_ADMINS) {
      const role = await Role.findOne({ name: a.roleName, deletedAt: null });
      if (!role) {
        console.error(`ABORT: role not found: "${a.roleName}". run the local role seed first`);
        process.exitCode = 1;
        return;
      }
      const dept = await Department.findById(role.departmentId);
      if (!dept) {
        console.error(`ABORT: department not found for role "${a.roleName}" (departmentId=${role.departmentId}).`);
        process.exitCode = 1;
        return;
      }
      resolved.push({ ...a, role, dept });
    }

    const hashedPassword = await CreateHash(PASSWORD);

    // Pass 1: upsert every admin by email (no reportingManagerId yet) so all _ids exist.
    const adminByEmail = {};
    for (const a of resolved) {
      const admin = await Admin.findOneAndUpdate(
        { email: a.email },
        {
          $set: {
            name: a.name,
            phone: a.phone,
            roleId: a.role._id,
            departmentId: a.dept._id,
            status: "active",
          },
          $setOnInsert: {
            email: a.email,
            password: hashedPassword,
            roles: a.legacyRoles,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      adminByEmail[a.email] = admin;
    }

    // Pass 2: wire the reporting chain now that every admin _id is known.
    for (const a of resolved) {
      const admin = adminByEmail[a.email];
      const manager = a.reportsTo ? adminByEmail[a.reportsTo] : null;
      const managerId = manager ? manager._id : null;
      admin.reportingManagerId = managerId;
      await admin.save();
      console.log(
        `[admin] ${admin.email}  _id=${admin._id}  roleId=${admin.roleId}  reportingManagerId=${admin.reportingManagerId}`
      );
    }

    console.log("\nHierarchy seed complete.");
  } catch (error) {
    console.error("Hierarchy seed error:", error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected.");
  }
})();
