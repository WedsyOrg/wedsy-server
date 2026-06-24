/* MB5+6 permission seed-diff.
 *
 * Grants (idempotent, append-only — never removes anything):
 *   leads:triage:all          → sales-lead-class roles: Revenue Head, Sales Manager
 *   settings_scripts:edit:all → CRM Admin (cockpit scripts category; founder's
 *                               *:*:all wildcard already covers both grants)
 *
 * Dry-run by default; --confirm applies. Prints a per-role diff either way.
 * Usage: node scripts/mb56-seed-permissions.js [--confirm]
 */
require("dotenv").config();
const mongoose = require("mongoose");

const CONFIRM = process.argv.includes("--confirm");

const GRANTS = [
  { roles: ["Revenue Head", "Sales Manager"], permission: "leads:triage:all" },
  { roles: ["CRM Admin"], permission: "settings_scripts:edit:all" },
];

(async () => {
  await mongoose.connect(process.env.DATABASE_URL);
  const Role = require("../models/Role");

  let changes = 0;
  for (const grant of GRANTS) {
    for (const roleName of grant.roles) {
      const role = await Role.findOne({ name: roleName, deletedAt: null });
      if (!role) {
        console.log(`- ${roleName}: NOT FOUND (skipped)`);
        continue;
      }
      if ((role.permissions || []).includes(grant.permission)) {
        console.log(`= ${roleName}: already has ${grant.permission}`);
        continue;
      }
      changes++;
      console.log(`+ ${roleName}: grant ${grant.permission}`);
      if (CONFIRM) {
        role.permissions.push(grant.permission);
        await role.save();
      }
    }
  }
  console.log(
    changes === 0
      ? "\nNothing to do."
      : CONFIRM
        ? `\nApplied ${changes} grant(s).`
        : `\nDRY RUN — ${changes} grant(s) pending. Re-run with --confirm.`
  );
  await mongoose.disconnect();
  process.exit(0);
})();
