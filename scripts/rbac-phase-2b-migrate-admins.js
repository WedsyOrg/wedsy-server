/**
 * RBAC Phase 2B — Admin migration (Slice 2)
 * Maps legacy Admin.roles[] -> roleId + departmentId, and seeds default
 * status / joinedAt / meta / reportingManagerId on existing admins.
 *
 * Mapping:
 *   roles includes "owner" -> Founder role + Founders dept (owner wins over crm)
 *   roles includes "crm"   -> Sales Executive role + Sales dept
 *   neither                -> roleId/departmentId left null + warning
 *
 * Idempotent: only sets fields currently null/missing. Legacy roles[] never modified.
 * LOCAL DEV DB ONLY — aborts if DATABASE_URL is not localhost.
 * Run: node scripts/rbac-phase-2b-migrate-admins.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");

const dbUrl = process.env.DATABASE_URL || "";
if (!dbUrl.startsWith("mongodb://localhost")) {
  console.error("ABORT: DATABASE_URL is not a localhost URI. This migration runs on the local dev DB only.");
  console.error(`DATABASE_URL = ${dbUrl || "(empty)"}`);
  process.exit(1);
}

(async () => {
  try {
    await mongoose.connect(dbUrl);
    console.log(`Connected to ${dbUrl}`);

    const [founderRole, foundersDept, salesExecRole, salesDept] = await Promise.all([
      Role.findOne({ name: "Founder" }),
      Department.findOne({ name: "Founders" }),
      Role.findOne({ name: "Sales Executive" }),
      Department.findOne({ name: "Sales" }),
    ]);

    if (!founderRole || !foundersDept || !salesExecRole || !salesDept) {
      console.error("ABORT: required seed records missing. Run rbac-phase-2b-seed-roles.js first.");
      console.error({ founderRole: !!founderRole, foundersDept: !!foundersDept, salesExecRole: !!salesExecRole, salesDept: !!salesDept });
      process.exitCode = 1;
      return;
    }

    const admins = await Admin.find({}).lean(); // lean -> missing fields are undefined, not schema defaults
    console.log(`Found ${admins.length} admins`);

    let migrated = 0;
    let noop = 0;

    for (const admin of admins) {
      const set = {};

      if (admin.roleId == null) {
        if (Array.isArray(admin.roles) && admin.roles.includes("owner")) {
          set.roleId = founderRole._id;
          set.departmentId = foundersDept._id;
        } else if (Array.isArray(admin.roles) && admin.roles.includes("crm")) {
          set.roleId = salesExecRole._id;
          set.departmentId = salesDept._id;
        } else {
          console.warn(`[admin] no role mapping for ${admin.email} (roles: ${JSON.stringify(admin.roles)}) — roleId left null`);
        }
      }

      if (admin.status == null) set.status = "active";
      if (admin.joinedAt == null) set.joinedAt = new Date();
      if (typeof admin.reportingManagerId === "undefined") set.reportingManagerId = null;
      if (admin.meta == null) set.meta = { designation: "", employeeId: "", profilePhoto: "" };

      if (Object.keys(set).length === 0) {
        console.log(`[admin] no-op (already migrated): ${admin.email}`);
        noop++;
        continue;
      }

      await Admin.updateOne({ _id: admin._id }, { $set: set }, { runValidators: true });
      console.log(`[admin] migrated ${admin.email} ->`, set);
      migrated++;
    }

    console.log(`\nMigration complete. Migrated: ${migrated}, no-op: ${noop}`);

    const after = await Admin.find({}, { name: 1, email: 1, roles: 1, roleId: 1, departmentId: 1, status: 1, joinedAt: 1, meta: 1 }).lean();
    console.log("\nPost-migration admins:");
    console.dir(after, { depth: null });
  } catch (error) {
    console.error("Migration error:", error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected.");
  }
})();
