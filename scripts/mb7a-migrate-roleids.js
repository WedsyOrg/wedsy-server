/* MB7a RBAC v2 migration — default each admin's single roleId into roleIds[].
 *
 * Idempotent + additive: only admins with a roleId and an empty roleIds[] are
 * touched (roleIds set to [roleId]); roleId is left intact for back-compat.
 * Re-running finds nothing to do. Dry-run by default; --confirm applies.
 * Usage: node scripts/mb7a-migrate-roleids.js [--confirm]   (NOT run against prod here)
 */
require("dotenv").config();
const mongoose = require("mongoose");

const CONFIRM = process.argv.includes("--confirm");

(async () => {
  await mongoose.connect(process.env.DATABASE_URL);
  const Admin = require("../models/Admin");

  const pending = await Admin.find(
    { roleId: { $ne: null }, $or: [{ roleIds: { $exists: false } }, { roleIds: { $size: 0 } }] },
    { _id: 1, name: 1, roleId: 1 }
  ).lean();

  console.log(`admins needing roleIds backfill: ${pending.length}`);
  for (const a of pending) {
    console.log(`+ ${a.name}: roleIds = [${a.roleId}]`);
    if (CONFIRM) {
      await Admin.updateOne({ _id: a._id }, { $set: { roleIds: [a.roleId] } });
    }
  }
  console.log(
    pending.length === 0
      ? "\nNothing to do — every roled admin already has roleIds[]."
      : CONFIRM
        ? `\nBackfilled ${pending.length} admin(s).`
        : `\nDRY RUN — ${pending.length} admin(s) pending. Re-run with --confirm.`
  );
  await mongoose.disconnect();
  process.exit(0);
})();
