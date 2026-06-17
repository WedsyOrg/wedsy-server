/**
 * RBAC Phase 2B — Admin migration, PRODUCTION variant (Decision 3 Step 2).
 *
 * DEPLOY-WINDOW USE ONLY. Maps legacy Admin.roles[] -> roleId + departmentId and
 * seeds status / joinedAt / meta / reportingManagerId on existing admins, exactly
 * like the local script — but pointed at prod, with hard safety rails:
 *
 *   - Connection string comes from process.env.PROD_MIGRATION_URI (set at run time,
 *     NEVER committed). The repo .env is ignored by this script.
 *   - DRY RUN BY DEFAULT: with no flag it connects, reports what WOULD change, writes nothing.
 *   - Pass --confirm-prod to actually write. Without it, zero writes.
 *   - Prints a loud banner echoing the target host before doing anything.
 *
 * Run (dry run):   PROD_MIGRATION_URI="mongodb+srv://...:.../wedsy" node scripts/rbac-phase-2b-migrate-admins-PROD.js
 * Run (for real):  PROD_MIGRATION_URI="mongodb+srv://...:.../wedsy" node scripts/rbac-phase-2b-migrate-admins-PROD.js --confirm-prod
 *
 * MUST run in the same deploy window as rbac-phase-2b-set-protected (prod copy) and
 * BEFORE requirePermission ships / widens, since the enforcement guard is fail-closed.
 */

const mongoose = require("mongoose");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");

const dbUrl = process.env.PROD_MIGRATION_URI || "";
const CONFIRM = process.argv.includes("--confirm-prod");

if (!dbUrl) {
  console.error("ABORT: PROD_MIGRATION_URI is not set. Set it at run time; do not hardcode the prod URI.");
  process.exit(1);
}

function hostOf(uri) {
  try {
    return uri.replace(/\/\/[^@]*@/, "//<redacted>@").replace(/^(mongodb(?:\+srv)?:\/\/[^/]+).*$/, "$1");
  } catch {
    return "(unparseable)";
  }
}

console.log("============================================================");
console.log("  RBAC ADMIN MIGRATION — PRODUCTION VARIANT");
console.log("  Target : " + hostOf(dbUrl));
console.log("  Mode   : " + (CONFIRM ? ">>> LIVE WRITE (--confirm-prod) <<<" : "DRY RUN (no writes) — pass --confirm-prod to apply"));
console.log("============================================================\n");

(async () => {
  try {
    await mongoose.connect(dbUrl);
    console.log(`Connected to ${hostOf(dbUrl)}`);

    const [founderRole, foundersDept, salesExecRole, salesDept] = await Promise.all([
      Role.findOne({ name: "Founder" }),
      Department.findOne({ name: "Founders" }),
      Role.findOne({ name: "Sales Executive" }),
      Department.findOne({ name: "Sales" }),
    ]);

    if (!founderRole || !foundersDept || !salesExecRole || !salesDept) {
      console.error("ABORT: required seed records missing in prod. Seed roles/departments first.");
      console.error({ founderRole: !!founderRole, foundersDept: !!foundersDept, salesExecRole: !!salesExecRole, salesDept: !!salesDept });
      process.exitCode = 1;
      return;
    }

    const admins = await Admin.find({}).lean();
    console.log(`Found ${admins.length} admins\n`);

    let wouldChange = 0;
    let wrote = 0;
    let noop = 0;
    let unmapped = 0;

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
          console.warn(`[UNMAPPED] ${admin.email} (roles: ${JSON.stringify(admin.roles)}) — roleId would stay null; this admin will 403 on enforced routes`);
          unmapped++;
        }
      }

      if (admin.status == null) set.status = "active";
      if (admin.joinedAt == null) set.joinedAt = new Date();
      if (typeof admin.reportingManagerId === "undefined") set.reportingManagerId = null;
      if (admin.meta == null) set.meta = { designation: "", employeeId: "", profilePhoto: "" };

      if (Object.keys(set).length === 0) {
        noop++;
        continue;
      }

      if (CONFIRM) {
        await Admin.updateOne({ _id: admin._id }, { $set: set }, { runValidators: true });
        console.log(`[WROTE] ${admin.email} ->`, set);
        wrote++;
      } else {
        console.log(`[WOULD WRITE] ${admin.email} ->`, set);
        wouldChange++;
      }
    }

    console.log("\n------------------------------------------------------------");
    if (CONFIRM) {
      console.log(`LIVE WRITE complete. Wrote: ${wrote}, no-op: ${noop}, unmapped: ${unmapped}`);
    } else {
      console.log(`DRY RUN complete. Would write: ${wouldChange}, no-op: ${noop}, unmapped: ${unmapped}`);
      console.log("No changes were made. Re-run with --confirm-prod to apply.");
    }
    if (unmapped > 0) {
      console.log(`\n!! ${unmapped} admin(s) have NO role mapping. They will be denied (403) on any enforced route until assigned a roleId. Resolve before widening enforcement.`);
    }

    const after = await Admin.find({}, { name: 1, email: 1, roles: 1, roleId: 1, departmentId: 1, status: 1 }).lean();
    console.log("\nAdmin role state (post-run):");
    console.dir(after, { depth: null });
  } catch (error) {
    console.error("Migration error:", error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log("\nDisconnected.");
  }
})();
