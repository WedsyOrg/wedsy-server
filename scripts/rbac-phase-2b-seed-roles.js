/**
 * RBAC Phase 2B — Seed script (Slice 1)
 * Seeds 4 default departments + 8 default roles with skeleton permissions.
 * Idempotent: existing records (matched by name) are left untouched.
 * LOCAL DEV DB ONLY — aborts if DATABASE_URL is not localhost.
 *
 * Run: node scripts/rbac-phase-2b-seed-roles.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Department = require("../models/Department");
const Role = require("../models/Role");

// --- HARD PROD GUARD: this script must never touch prod ---
const dbUrl = process.env.DATABASE_URL || "";
if (!dbUrl.startsWith("mongodb://localhost")) {
  console.error("ABORT: DATABASE_URL is not a localhost URI. This seed runs on the local dev DB only.");
  console.error(`DATABASE_URL = ${dbUrl || "(empty)"}`);
  process.exit(1);
}

const DEPARTMENTS = [
  { name: "Founders", description: "Founders and company leadership" },
  { name: "Sales", description: "Lead conversion and pipeline" },
  { name: "Operations", description: "Project execution and delivery" },
  { name: "Client Servicing", description: "Client relationship and account management" },
];

const ROLES = [
  { name: "Founder", department: "Founders", permissions: ["*:*:all"] },
  { name: "CRM Admin", department: "Founders", permissions: ["users:*:all", "roles:*:all", "settings:*:all"] },
  { name: "Sales Manager", department: "Sales", permissions: ["leads:view:team", "leads:edit:team", "leads:assign:team"] },
  { name: "Sales Executive", department: "Sales", permissions: ["leads:view:own", "leads:edit:own"] },
  { name: "Operations Manager", department: "Operations", permissions: ["projects:view:department", "tasks:view:department"] },
  { name: "Operations Executive", department: "Operations", permissions: ["projects:view:own", "tasks:view:own"] },
  { name: "Client Servicing Manager", department: "Client Servicing", permissions: ["projects:view:team", "tasks:view:team"] },
  { name: "Client Servicing Executive", department: "Client Servicing", permissions: ["projects:view:own", "tasks:view:own"] },
];

(async () => {
  try {
    await mongoose.connect(dbUrl);
    console.log(`Connected to ${dbUrl}`);

    const deptByName = {};
    for (const d of DEPARTMENTS) {
      let dept = await Department.findOne({ name: d.name });
      if (dept) {
        console.log(`[dept] exists, skipped: ${d.name}`);
      } else {
        dept = await Department.create({ name: d.name, description: d.description, isSystem: true });
        console.log(`[dept] created: ${d.name}`);
      }
      deptByName[d.name] = dept._id;
    }

    for (const r of ROLES) {
      const departmentId = deptByName[r.department];
      if (!departmentId) {
        console.warn(`[role] SKIP ${r.name} — department not found: ${r.department}`);
        continue;
      }
      const existing = await Role.findOne({ name: r.name });
      if (existing) {
        console.log(`[role] exists, skipped: ${r.name}`);
      } else {
        await Role.create({
          name: r.name,
          departmentId,
          description: "",
          permissions: r.permissions,
          isSystem: true,
        });
        console.log(`[role] created: ${r.name} -> ${r.department}`);
      }
    }

    const deptCount = await Department.countDocuments({ deletedAt: null });
    const roleCount = await Role.countDocuments({ deletedAt: null });
    console.log(`\nSeed complete. Departments: ${deptCount}, Roles: ${roleCount}`);
  } catch (error) {
    console.error("Seed error:", error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected.");
  }
})();
