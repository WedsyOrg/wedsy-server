/**
 * scripts/migrate-rbac-v2.js
 *
 * RBAC v2 (D5) one-shot backfill: for every venue with team members, seed the
 * system Owner role + default bundles (only where the venue has NO roles yet)
 * and map legacy 5-enum members onto bundles via roleRef. Purely ADDITIVE —
 * the legacy `role` string stays on every member as the fallback, no
 * capability data is removed, and venues whose owner already edited roles are
 * never re-seeded. Running it is optional: the same seeding/migration happens
 * lazily on first touch of each venue's team/roles surface.
 *
 * SAFETY: refuses to run unless DATABASE_URL points at a local Mongo host
 * (same guard as scripts/seed-test-venue.js).
 *
 * Usage:
 *   node scripts/migrate-rbac-v2.js           # dry-run (default)
 *   node scripts/migrate-rbac-v2.js --apply   # seed + assign roleRefs
 */
require("dotenv").config();
const mongoose = require("mongoose");
const VenueTeamMember = require("../models/VenueTeamMember");
const VenueRole = require("../models/VenueRole");
const { ensureVenueRoles, migrateLegacyMembers } = require("../utils/venueRbac");
const { LEGACY_ROLE_TO_BUNDLE } = require("../utils/venueRoles");

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);
const APPLY = process.argv.includes("--apply");

function assertLocalMongo() {
  const url = process.env.DATABASE_URL || "";
  let host;
  try {
    host = new URL(url).hostname;
  } catch (e) {
    throw new Error(`Cannot parse DATABASE_URL to verify host: ${e.message}`);
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `Refusing to run: DATABASE_URL host "${host}" is not local. ` +
        `This migration only runs against a local dev Mongo (127.0.0.1/localhost).`
    );
  }
  return host;
}

async function run() {
  const host = assertLocalMongo();
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 8000 });
  console.log(`[migrate-rbac-v2] connected to local Mongo @ ${host} (${APPLY ? "APPLY" : "DRY-RUN"})`);

  const venueIds = await VenueTeamMember.distinct("venueId");
  const unmapped = await VenueTeamMember.countDocuments({ roleRef: { $exists: false } });
  console.log(`[migrate-rbac-v2] ${venueIds.length} venue(s) with members; ${unmapped} member(s) lack roleRef`);
  const byRole = await VenueTeamMember.aggregate([
    { $match: { roleRef: { $exists: false } } },
    { $group: { _id: "$role", n: { $sum: 1 } } },
  ]);
  for (const r of byRole) {
    console.log(`  legacy "${r._id}" → bundle "${LEGACY_ROLE_TO_BUNDLE[r._id] || "(none — stays on legacy resolution)"}": ${r.n}`);
  }

  if (!APPLY) {
    console.log("[migrate-rbac-v2] DRY-RUN — no changes written. Re-run with --apply to seed + assign.");
  } else {
    let totalMigrated = 0;
    for (const venueId of venueIds) {
      await ensureVenueRoles(venueId);
      totalMigrated += await migrateLegacyMembers(venueId);
    }
    const roleCount = await VenueRole.countDocuments({});
    console.log(`[migrate-rbac-v2] migrated ${totalMigrated} member(s); ${roleCount} role bundle(s) exist across all venues.`);
  }

  await mongoose.disconnect();
  console.log("[migrate-rbac-v2] DONE");
}

run().catch((err) => {
  console.error(`[migrate-rbac-v2] FAILED: ${err.message}`);
  process.exit(1);
});
