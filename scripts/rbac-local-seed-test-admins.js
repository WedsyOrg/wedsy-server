/**
 * RBAC — Local test admins seed
 * Idempotently creates two login-able test admins wired to seeded RBAC roles:
 *   1. test-founder@local.test    -> role "Founder"
 *   2. test-salesexec@local.test  -> role "Sales Executive"
 * Both get password "LocalTest123!" (bcrypt-hashed via utils/password, which is
 * what POST /auth/admin -> AdminLogin validates against), so they can log in and
 * receive a JWT.
 *
 * Requires the role/department seed to have run first
 * (scripts/rbac-phase-2b-seed-roles.js).
 *
 * LOCAL DEV DB ONLY — aborts if DATABASE_URL is not localhost.
 *
 * Run: node scripts/rbac-local-seed-test-admins.js
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

// Test admins to seed. `legacyRoles` satisfies the required legacy Admin.roles[]
// enum; roleId/departmentId come from the looked-up RBAC role.
const TEST_ADMINS = [
  {
    name: "Test Founder",
    email: "test-founder@local.test",
    phone: "0000000001",
    roleName: "Founder",
    legacyRoles: ["owner"],
  },
  {
    name: "Test Sales Executive",
    email: "test-salesexec@local.test",
    phone: "0000000002",
    roleName: "Sales Executive",
    legacyRoles: ["sales"],
  },
];

(async () => {
  try {
    await mongoose.connect(dbUrl);
    console.log(`Connected to ${dbUrl}`);

    // Resolve and validate all required roles up front; abort if any missing.
    const resolved = [];
    for (const a of TEST_ADMINS) {
      const role = await Role.findOne({ name: a.roleName, deletedAt: null });
      if (!role) {
        console.error(`ABORT: role not found: "${a.roleName}". Run scripts/rbac-phase-2b-seed-roles.js first.`);
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

    for (const a of resolved) {
      const existing = await Admin.findOne({ email: a.email });
      if (existing) {
        console.log(`[admin] exists, skipped: ${a.email}`);
        continue;
      }
      await Admin.create({
        name: a.name,
        email: a.email,
        phone: a.phone,
        password: hashedPassword,
        roles: a.legacyRoles,
        roleId: a.role._id,
        departmentId: a.dept._id,
        status: "active",
      });
      console.log(`[admin] created: ${a.email} -> role "${a.role.name}" / dept "${a.dept.name}" (password "${PASSWORD}")`);
    }

    console.log("\nSeed complete.");
  } catch (error) {
    console.error("Seed error:", error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected.");
  }
})();
