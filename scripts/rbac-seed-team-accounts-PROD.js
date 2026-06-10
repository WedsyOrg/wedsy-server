/**
 * ONE-TIME PROD SEED — Wedsy OS RBAC team accounts.
 *
 * Part A: adjusts three Sales-track roles (rename Sales Manager -> Revenue Head,
 *         re-scope Sales Executive, ensure Sales Intern exists).
 * Part B: creates 8 staff Admin accounts with roleId / departmentId /
 *         reportingManagerId wired up, in manager-before-report order.
 *
 * Writes to production. Designed to be IDEMPOTENT and SAFE TO RE-RUN:
 *   - role rename is skipped if "Revenue Head" already exists
 *   - role permission sets are written to an exact target each run (stable)
 *   - accounts are keyed on email; an existing email is SKIPPED, never modified
 *   - if any required department/role is missing, it ABORTS before creating any
 *     account (no half-seeding)
 *
 * NOTE: the Admin schema requires a non-empty `phone`, but phone is NOT used for
 * login or RBAC — email is the identifier. Each created account is therefore
 * given phone = "PENDING" intentionally, to be filled in later via Settings.
 */

require("dotenv").config();
const crypto = require("crypto");
const mongoose = require("mongoose");

const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");
const { CreateHash } = require("../utils/password");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Strong 16-char password using crypto: guarantees >=1 upper/lower/digit/symbol.
function generatePassword() {
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const lower = "abcdefghijklmnopqrstuvwxyz";
  const digits = "0123456789";
  const symbols = "!@#$%^&*()-_=+[]{}";
  const all = upper + lower + digits + symbols;

  const pick = (set) => set[crypto.randomInt(set.length)];

  const chars = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  while (chars.length < 16) chars.push(pick(all));

  // Fisher-Yates shuffle with crypto randomness so the guaranteed chars aren't
  // always at the front.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

// "aafiya@wedsy.in" -> "Aafiya" (display names are editable later).
function nameFromEmail(email) {
  const local = String(email).split("@")[0] || "";
  if (!local) return email;
  return local.charAt(0).toUpperCase() + local.slice(1).toLowerCase();
}

// ---------------------------------------------------------------------------
// Target permission sets (exact)
// ---------------------------------------------------------------------------

const PERMS_REVENUE_HEAD = [
  "leads:view:department",
  "leads:edit:department",
  "leads:create:department",
  "projects:view:department",
  "tasks:view:department",
  "tasks:edit:department",
  "incentives:view:department",
  "incentives:approve:department",
  "users:view:department",
  "reports:view:department",
];

const PERMS_SALES_EXECUTIVE = [
  "leads:view:team",
  "leads:edit:team",
  "leads:create:own",
  "projects:view:own",
  "tasks:view:own",
  "tasks:edit:own",
  "incentives:view:own",
];

const PERMS_SALES_INTERN = [
  "leads:view:own",
  "leads:edit:own",
  "leads:create:own",
  "tasks:view:own",
  "tasks:edit:own",
];

// ---------------------------------------------------------------------------
// Accounts to seed — IN DEPENDENCY ORDER (managers before their reports)
// ---------------------------------------------------------------------------

const ACCOUNTS = [
  { email: "rohaan@wedsy.in",  roles: ["owner"], roleName: "Founder",                     deptName: "Founders",         managerEmail: null },
  { email: "riyaan@wedsy.in",  roles: ["owner"], roleName: "Founder",                     deptName: "Founders",         managerEmail: null },
  { email: "asha@wedsy.in",    roles: ["sales"], roleName: "Revenue Head",                deptName: "Sales",            managerEmail: "rohaan@wedsy.in" },
  { email: "aafiya@wedsy.in",  roles: ["sales"], roleName: "Sales Executive",             deptName: "Sales",            managerEmail: "asha@wedsy.in" },
  { email: "varsha@wedsy.in",  roles: ["sales"], roleName: "Sales Executive",             deptName: "Sales",            managerEmail: "asha@wedsy.in" },
  { email: "lekiwao@wedsy.in", roles: ["sales"], roleName: "Sales Intern",                deptName: "Sales",            managerEmail: "aafiya@wedsy.in" },
  { email: "hiren@wedsy.in",   roles: ["sales"], roleName: "Sales Intern",                deptName: "Sales",            managerEmail: "aafiya@wedsy.in" },
  { email: "puspita@wedsy.in", roles: ["crm"],   roleName: "Client Servicing Executive",  deptName: "Client Servicing", managerEmail: "riyaan@wedsy.in" },
];

const REQUIRED_DEPTS = ["Founders", "Sales", "Client Servicing"];
const REQUIRED_ROLES = [
  "Founder",
  "Revenue Head",
  "Sales Executive",
  "Sales Intern",
  "Client Servicing Executive",
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL);
    console.log("✅ Connected to DB. Beginning RBAC team seed.\n");

    // =======================================================================
    // PART A — role adjustments
    // =======================================================================
    console.log("=== PART A — role adjustments ===\n");

    // A.1 — Sales Manager -> Revenue Head, then re-assert permissions every run.
    console.log("[A.1] Sales Manager -> Revenue Head (+ re-assert permissions)");
    let revenueHeadRole = await Role.findOne({ name: "Revenue Head" });
    if (revenueHeadRole) {
      console.log(
        `      'Revenue Head' already exists (${revenueHeadRole._id}) — skipping rename.`
      );
    } else {
      const salesManager = await Role.findOne({ name: "Sales Manager" });
      if (salesManager) {
        console.log(
          `      Found 'Sales Manager' (${salesManager._id}) — renaming to 'Revenue Head'.`
        );
        salesManager.name = "Revenue Head";
        await salesManager.save();
        revenueHeadRole = salesManager;
        console.log("      ✅ Renamed 'Sales Manager' -> 'Revenue Head'.");
      } else {
        console.log(
          "      ⚠️  Neither 'Sales Manager' nor 'Revenue Head' found. " +
            "Revenue Head will be missing — Part B will abort."
        );
      }
    }

    // Always set Revenue Head's permissions to the exact target so this script
    // remains the source of truth for that role's scope.
    if (revenueHeadRole) {
      console.log(
        `      Before: permissions=${JSON.stringify(revenueHeadRole.permissions)}`
      );
      revenueHeadRole.permissions = PERMS_REVENUE_HEAD;
      await revenueHeadRole.save();
      console.log(
        `      After:  permissions=${JSON.stringify(revenueHeadRole.permissions)}`
      );
      console.log("      ✅ Revenue Head permissions re-asserted.");
    } else {
      console.log(
        "      ⚠️  Skipping permission re-assert — no 'Revenue Head' role present."
      );
    }
    console.log("");

    // A.2 — Sales Executive re-scope
    console.log("[A.2] Sales Executive permissions");
    const salesExec = await Role.findOne({ name: "Sales Executive" });
    if (salesExec) {
      console.log(
        `      Before: permissions=${JSON.stringify(salesExec.permissions)}`
      );
      salesExec.permissions = PERMS_SALES_EXECUTIVE;
      await salesExec.save();
      console.log(
        `      After:  permissions=${JSON.stringify(salesExec.permissions)}`
      );
      console.log("      ✅ Updated.");
    } else {
      console.log(
        "      ⚠️  'Sales Executive' role not found — cannot set permissions. " +
          "Part B will abort."
      );
    }
    console.log("");

    // A.3 — Ensure Sales Intern exists
    console.log("[A.3] Ensure 'Sales Intern' role");
    const existingIntern = await Role.findOne({ name: "Sales Intern" });
    if (existingIntern) {
      console.log(
        `      'Sales Intern' already exists (${existingIntern._id}) — leaving it.`
      );
    } else {
      const salesDeptForIntern = await Department.findOne({ name: "Sales" });
      if (!salesDeptForIntern) {
        throw new Error(
          "ABORT [A.3]: cannot create 'Sales Intern' — 'Sales' department not found."
        );
      }
      const intern = await Role.create({
        name: "Sales Intern",
        departmentId: salesDeptForIntern._id,
        permissions: PERMS_SALES_INTERN,
        protected: false,
      });
      console.log(
        `      ✅ Created 'Sales Intern' (${intern._id}) in dept Sales ` +
          `(${salesDeptForIntern._id}) with permissions=${JSON.stringify(
            intern.permissions
          )}.`
      );
    }
    console.log("");

    // =======================================================================
    // PART B — create accounts
    // =======================================================================
    console.log("=== PART B — create accounts ===\n");

    // Resolve & cache departments and roles by name.
    console.log("[B.0] Resolving required departments and roles...");
    const deptByName = {};
    const roleByName = {};
    const missing = [];

    for (const dn of REQUIRED_DEPTS) {
      const d = await Department.findOne({ name: dn });
      if (d) {
        deptByName[dn] = d;
        console.log(`      dept '${dn}' -> ${d._id}`);
      } else {
        missing.push(`department '${dn}'`);
        console.log(`      dept '${dn}' -> MISSING`);
      }
    }
    for (const rn of REQUIRED_ROLES) {
      const r = await Role.findOne({ name: rn });
      if (r) {
        roleByName[rn] = r;
        console.log(`      role '${rn}' -> ${r._id}`);
      } else {
        missing.push(`role '${rn}'`);
        console.log(`      role '${rn}' -> MISSING`);
      }
    }

    if (missing.length) {
      throw new Error(
        "ABORT [B.0]: missing required prerequisites before seeding — " +
          missing.join(", ") +
          ". No accounts were created."
      );
    }
    console.log("      ✅ All required departments and roles present.\n");

    // Create accounts in order; cache each resulting Admin by email so reports
    // can resolve their manager's _id from the just-created/existing record.
    const adminByEmail = {};
    const summary = [];

    for (let idx = 0; idx < ACCOUNTS.length; idx++) {
      const acct = ACCOUNTS[idx];
      const displayName = nameFromEmail(acct.email);
      console.log(`[B.${idx + 1}] ${acct.email} (${displayName})`);

      const existing = await Admin.findOne({ email: acct.email });
      if (existing) {
        adminByEmail[acct.email] = existing;
        console.log("      exists, skipped (not modified).");
        summary.push({
          email: acct.email,
          role: acct.roleName,
          department: acct.deptName,
          reportingManager: acct.managerEmail || "—",
          password: "skipped (already existed)",
        });
        continue;
      }

      // Resolve reporting manager _id (manager was created/cached earlier).
      let reportingManagerId = null;
      if (acct.managerEmail) {
        const mgr =
          adminByEmail[acct.managerEmail] ||
          (await Admin.findOne({ email: acct.managerEmail }));
        if (!mgr) {
          throw new Error(
            `ABORT [B.${idx + 1}]: reporting manager '${acct.managerEmail}' ` +
              `not found for '${acct.email}'. Aborting to avoid an orphaned hierarchy.`
          );
        }
        reportingManagerId = mgr._id;
      }

      const plainPassword = generatePassword();
      const hashed = await CreateHash(plainPassword);

      const created = await Admin.create({
        name: displayName,
        email: acct.email,
        phone: "PENDING", // intentional placeholder — fill in later via Settings (not used for login/RBAC)
        password: hashed,
        roles: acct.roles,
        roleId: roleByName[acct.roleName]._id,
        departmentId: deptByName[acct.deptName]._id,
        reportingManagerId,
        status: "active",
      });

      adminByEmail[acct.email] = created;
      console.log(
        `      ✅ created (${created._id}) | role=${acct.roleName} | ` +
          `dept=${acct.deptName} | manager=${acct.managerEmail || "—"} | ` +
          `phone=PENDING`
      );
      summary.push({
        email: acct.email,
        role: acct.roleName,
        department: acct.deptName,
        reportingManager: acct.managerEmail || "—",
        password: plainPassword,
      });
    }

    // =======================================================================
    // SUMMARY
    // =======================================================================
    console.log("\n=== SUMMARY ===");
    console.table(summary);
    console.log(
      "\nℹ️  Phone is intentionally set to \"PENDING\" for every newly-created " +
        "account — fill it in later via Settings. Email is the identifier; " +
        "phone is not used for login or RBAC."
    );
    console.log(
      "⚠️  Plaintext passwords are shown ONCE above and are NOT stored " +
        "anywhere. Distribute credentials now; they cannot be recovered later."
    );
  } finally {
    await mongoose.disconnect();
    console.log("\n🔌 Disconnected.");
  }
})();
