/**
 * RBAC Phase 2B — Seed roles/departments, PRODUCTION variant.
 *
 * DEPLOY-WINDOW USE ONLY. Seeds the same 4 departments + 8 roles as the local seed
 * (scripts/rbac-phase-2b-seed-roles.js, sharing data via scripts/rbac-seed-data.js)
 * — but pointed at prod, with the same hard safety rails as the admin migration:
 *
 *   - Connection string comes from process.env.PROD_MIGRATION_URI (set at run time,
 *     NEVER committed). The repo .env is NOT loaded by this script.
 *   - DRY RUN BY DEFAULT: with no flag it connects, reports what WOULD be created,
 *     writes nothing.
 *   - Pass --confirm-prod to actually write. Without it, zero writes.
 *   - Prints a loud banner echoing the target host (credentials redacted) first.
 *   - Idempotent: existing records (matched by name) are skipped, never overwritten.
 *
 * Run (dry run):   PROD_MIGRATION_URI="mongodb+srv://...:.../wedsy" node scripts/rbac-phase-2b-seed-roles-PROD.js
 * Run (for real):  PROD_MIGRATION_URI="mongodb+srv://...:.../wedsy" node scripts/rbac-phase-2b-seed-roles-PROD.js --confirm-prod
 *
 * MUST run BEFORE rbac-phase-2b-migrate-admins-PROD.js (the migration aborts if the
 * Founder/Founders/Sales Executive/Sales seed records are missing).
 */

const mongoose = require("mongoose");
const Department = require("../models/Department");
const Role = require("../models/Role");
const { DEPARTMENTS, ROLES } = require("./rbac-seed-data");

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
console.log("  RBAC ROLE/DEPARTMENT SEED — PRODUCTION VARIANT");
console.log("  Target : " + hostOf(dbUrl));
console.log("  Mode   : " + (CONFIRM ? ">>> LIVE WRITE (--confirm-prod) <<<" : "DRY RUN (no writes) — pass --confirm-prod to apply"));
console.log("============================================================\n");

(async () => {
  try {
    await mongoose.connect(dbUrl);
    console.log(`Connected to ${hostOf(dbUrl)}`);

    let wrote = 0;
    let wouldChange = 0;
    let skipped = 0;

    // --- Departments ---
    const deptByName = {};
    for (const d of DEPARTMENTS) {
      const existing = await Department.findOne({ name: d.name });
      if (existing) {
        console.log(`[dept] exists, skipped: ${d.name}`);
        deptByName[d.name] = existing._id;
        skipped++;
        continue;
      }
      if (CONFIRM) {
        const dept = await Department.create({ name: d.name, description: d.description, isSystem: true });
        deptByName[d.name] = dept._id;
        console.log(`[dept] CREATED: ${d.name}`);
        wrote++;
      } else {
        console.log(`[WOULD CREATE] [dept] ${d.name}`);
        wouldChange++;
      }
    }

    // --- Roles ---
    for (const r of ROLES) {
      const departmentId = deptByName[r.department];
      const existing = await Role.findOne({ name: r.name });
      if (existing) {
        console.log(`[role] exists, skipped: ${r.name}`);
        skipped++;
        continue;
      }
      if (!departmentId) {
        // In dry run the parent dept may not exist yet (would be created on a live run).
        console.warn(`[role] ${r.name} — department "${r.department}" not present yet${CONFIRM ? "" : " (would be created on --confirm-prod run)"}`);
        if (CONFIRM) {
          console.warn(`[role] SKIP ${r.name} — department not found: ${r.department}`);
          continue;
        }
      }
      if (CONFIRM) {
        await Role.create({
          name: r.name,
          departmentId,
          description: "",
          permissions: r.permissions,
          isSystem: true,
        });
        console.log(`[role] CREATED: ${r.name} -> ${r.department}`);
        wrote++;
      } else {
        console.log(`[WOULD CREATE] [role] ${r.name} -> ${r.department} (${r.permissions.join(", ")})`);
        wouldChange++;
      }
    }

    console.log("\n------------------------------------------------------------");
    if (CONFIRM) {
      console.log(`LIVE WRITE complete. Created: ${wrote}, skipped (already present): ${skipped}`);
    } else {
      console.log(`DRY RUN complete. Would create: ${wouldChange}, skipped (already present): ${skipped}`);
      console.log("No changes were made. Re-run with --confirm-prod to apply.");
    }

    // --- Presence check for the 4 records the admin migration requires ---
    const [founderRole, foundersDept, salesExecRole, salesDept] = await Promise.all([
      Role.findOne({ name: "Founder" }),
      Department.findOne({ name: "Founders" }),
      Role.findOne({ name: "Sales Executive" }),
      Department.findOne({ name: "Sales" }),
    ]);

    console.log("\nMigration-prerequisite presence check:");
    console.log(`  founderRole   (Role "Founder")           : ${founderRole ? "PRESENT" : "MISSING"}`);
    console.log(`  foundersDept  (Department "Founders")     : ${foundersDept ? "PRESENT" : "MISSING"}`);
    console.log(`  salesExecRole (Role "Sales Executive")   : ${salesExecRole ? "PRESENT" : "MISSING"}`);
    console.log(`  salesDept     (Department "Sales")        : ${salesDept ? "PRESENT" : "MISSING"}`);

    const allPresent = founderRole && foundersDept && salesExecRole && salesDept;
    if (!allPresent) {
      if (CONFIRM) {
        console.log("\n!! One or more prerequisites are MISSING after a live run — investigate before running the admin migration.");
      } else {
        console.log("\n!! Prerequisites not all present — this was a DRY RUN. Re-run with --confirm-prod to create them.");
      }
    } else {
      console.log("\nAll 4 migration prerequisites present.");
    }
  } catch (error) {
    console.error("Seed error:", error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log("\nDisconnected.");
  }
})();
