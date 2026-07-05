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
 * SAFETY: refuses to run against a non-local Mongo UNLESS the operator
 * deliberately opts in with BOTH `ALLOW_REMOTE=1` and `--apply` (the guarded
 * production path — MB-V2 P3). Local hosts (127.0.0.1/localhost) always allowed.
 * The resolved host is printed prominently on every run.
 *
 * Usage:
 *   node scripts/migrate-rbac-v2.js                       # local dry-run (default)
 *   node scripts/migrate-rbac-v2.js --apply               # local seed + assign
 *   ALLOW_REMOTE=1 node scripts/migrate-rbac-v2.js --apply  # PROD run (both gates required)
 */
require("dotenv").config();
const mongoose = require("mongoose");
const VenueTeamMember = require("../models/VenueTeamMember");
const VenueRole = require("../models/VenueRole");
const { ensureVenueRoles, migrateLegacyMembers } = require("../utils/venueRbac");
const { LEGACY_ROLE_TO_BUNDLE } = require("../utils/venueRoles");

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);
const APPLY = process.argv.includes("--apply");
const ALLOW_REMOTE = process.env.ALLOW_REMOTE === "1";

// Resolve + gate the target host. Local is always fine. A remote host is only
// permitted when the operator sets BOTH gates (ALLOW_REMOTE=1 AND --apply) — a
// remote dry-run or a remote run missing either gate is refused. Whatever the
// outcome, the resolved host is surfaced loudly so a prod target is never a
// surprise.
function assertMongoTarget() {
  const url = process.env.DATABASE_URL || "";
  let host;
  try {
    host = new URL(url).hostname;
  } catch (e) {
    throw new Error(`Cannot parse DATABASE_URL to verify host: ${e.message}`);
  }
  const isLocal = LOCAL_HOSTS.has(host);
  console.log(`[migrate-rbac-v2] ┌───────────────────────────────────────────`);
  console.log(`[migrate-rbac-v2] │ TARGET HOST: ${host}  (${isLocal ? "local" : "REMOTE"})`);
  console.log(`[migrate-rbac-v2] │ MODE: ${APPLY ? "APPLY" : "DRY-RUN"}  ALLOW_REMOTE=${ALLOW_REMOTE ? "1" : "0"}`);
  console.log(`[migrate-rbac-v2] └───────────────────────────────────────────`);
  if (isLocal) return host;
  // Non-local: both gates required.
  if (!ALLOW_REMOTE || !APPLY) {
    throw new Error(
      `Refusing to run: DATABASE_URL host "${host}" is REMOTE. ` +
        `The guarded production path requires BOTH ALLOW_REMOTE=1 and --apply ` +
        `(got ALLOW_REMOTE=${ALLOW_REMOTE ? "1" : "0"}, ${APPLY ? "--apply" : "no --apply"}).`
    );
  }
  console.log(
    `[migrate-rbac-v2] ⚠  REMOTE APPLY authorized (ALLOW_REMOTE=1 + --apply) — writing to ${host}`
  );
  return host;
}

async function run() {
  const host = assertMongoTarget();
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
