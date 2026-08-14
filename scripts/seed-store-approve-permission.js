/* A2S — grant store:approve:all to a role (idempotent, append-only).
 *
 * GRANTS NOBODY BY DEFAULT. store:approve:all is a FOUNDER-ONLY capability:
 * the Founder role holds "*:*:all", which already satisfies it through the
 * normal requirePermission path (asserted in tests/a2s-decor-drafts.test.js),
 * so Rohaan needs no grant and none is seeded.
 *
 * This script exists only for a deliberate FUTURE grant, and requires an
 * explicit --roles argument. Run with no arguments to list the roles available.
 *
 *   node scripts/seed-store-approve-permission.js                       # list roles, grant nothing
 *   node scripts/seed-store-approve-permission.js --roles "Ops Manager" # dry run
 *   node scripts/seed-store-approve-permission.js --roles "Ops Manager" --confirm
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { validatePermissions } = require("../utils/rbacPermissions");

const CONFIRM = process.argv.includes("--confirm");
const PERMISSION = "store:approve:all";

const roleArgIdx = process.argv.indexOf("--roles");
const ROLES =
  roleArgIdx !== -1 && process.argv[roleArgIdx + 1] && !process.argv[roleArgIdx + 1].startsWith("--")
    ? process.argv[roleArgIdx + 1].split(",").map((s) => s.trim()).filter(Boolean)
    : [];

(async () => {
  // Fail fast if the vocabulary doesn't know this permission: validatePermissions
  // rejects the WHOLE array, so an unknown string would 400 every subsequent
  // save of that role — a far worse failure than not granting.
  const check = validatePermissions([PERMISSION]);
  if (!check.valid) {
    console.error(`REFUSING — "${PERMISSION}" is not a valid permission:`);
    check.errors.forEach((e) => console.error(`  - ${e}`));
    process.exit(1);
  }

  await mongoose.connect(process.env.DATABASE_URL);
  const Role = require("../models/Role");

  if (!ROLES.length) {
    const roles = await Role.find({ deletedAt: null }, { name: 1, systemKey: 1, permissions: 1 })
      .sort({ name: 1 })
      .lean();
    console.log(`\nNo --roles given — granting NOTHING (this is the default).`);
    console.log(
      `${PERMISSION} is founder-only by design; the Founder role's "*:*:all" already covers it.\n`
    );
    console.log("Available roles:");
    for (const r of roles) {
      const marks = [];
      if (r.systemKey === "founder") marks.push("FOUNDER");
      if ((r.permissions || []).includes("*:*:all")) marks.push("has *:*:all");
      if ((r.permissions || []).includes(PERMISSION)) marks.push(`has ${PERMISSION}`);
      console.log(`  ${r.name}${marks.length ? `   [${marks.join(", ")}]` : ""}`);
    }
    console.log(`\nTo grant deliberately:\n  node ${require("path").basename(__filename)} --roles "Role Name" --confirm`);
    await mongoose.disconnect();
    process.exit(0);
  }

  let changes = 0;
  for (const roleName of ROLES) {
    const role = await Role.findOne({ name: roleName, deletedAt: null });
    if (!role) {
      console.log(`- ${roleName}: NOT FOUND (skipped)`);
      continue;
    }
    if ((role.permissions || []).includes(PERMISSION)) {
      console.log(`= ${roleName}: already has ${PERMISSION}`);
      continue;
    }
    changes++;
    console.log(`+ ${roleName}: grant ${PERMISSION}`);
    if (CONFIRM) {
      role.permissions.push(PERMISSION);
      await role.save();
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
