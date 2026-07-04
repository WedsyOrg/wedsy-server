/* MB7a permission seed-diff (idempotent, append-only).
 *
 * Grants:
 *   settings_onboarding:edit:all → CRM Admin           (milestone settings, Slice 2)
 *   leads:onboard:all            → Revenue Head         (the Onboard button, Slice 4)
 *   projects:view:all            → Client Servicing Manager  (CS dashboard onboarded list, Slice 7)
 *   projects:view:team           → Client Servicing Executive
 * Founder holds *:*:all, so it already covers every grant.
 *
 * Dry-run by default; --confirm applies. Prints a per-role diff either way.
 * Usage: node scripts/mb7a-seed-permissions.js [--confirm]   (NOT run against prod here)
 */
require("dotenv").config();
const mongoose = require("mongoose");

const CONFIRM = process.argv.includes("--confirm");

const GRANTS = [
  { roles: ["CRM Admin"], permission: "settings_onboarding:edit:all" },
  { roles: ["Revenue Head"], permission: "leads:onboard:all" },
  { roles: ["Client Servicing Manager"], permission: "projects:view:all" },
  { roles: ["Client Servicing Executive"], permission: "projects:view:team" },
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
