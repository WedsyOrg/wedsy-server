/* Password-management permission seed-diff (idempotent, append-only).
 *
 * Grants:
 *   team:manage_access:all → CRM Admin (and "Admin" if present)
 * This permission gates BOTH admin-set-password (Slice 2) and disable/enable
 * (Slice 3). The founder holds *:*:all, which already covers it — regular
 * members do NOT get it.
 *
 * NOTE on the name: the brief calls it "team:manage-access"; the codebase's
 * requirePermission parses "resource:action:scope" (3 colon-parts), so it is
 * encoded as "team:manage_access:all".
 *
 * Dry-run by default; --confirm applies. Prints a per-role diff either way.
 * Usage: node scripts/password-mgmt-seed-permissions.js [--confirm]   (NOT run against prod here)
 */
require("dotenv").config();
const mongoose = require("mongoose");

const CONFIRM = process.argv.includes("--confirm");

const GRANTS = [
  { roles: ["CRM Admin", "Admin"], permission: "team:manage_access:all" },
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
