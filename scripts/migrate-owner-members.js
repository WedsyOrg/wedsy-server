/**
 * scripts/migrate-owner-members.js
 *
 * Owner-as-member backfill: give every active VenueOwner their own
 * VenueTeamMember row (utils/venueOwnerMember), so the owner is a real assignee
 * for leads, tasks and follow-ups instead of the UI pretending "You (owner)"
 * means unassigned.
 *
 * Purely ADDITIVE and entirely OPTIONAL — the same ensure runs lazily on owner
 * login, on any touch of the team surface, and on the first "Me" resolution.
 * This script only warms the rows ahead of a deploy so the first request after
 * the release isn't the one paying for the write.
 *
 * Two outcomes per owner, both reported:
 *   CREATE — no member row holds the owner's phone; a fresh owner row is made.
 *   ADOPT  — a member row ALREADY holds that phone, because the owner invited
 *            themselves to get an assignable identity. That row is converted in
 *            place (flagged isOwnerAccount, upgraded to the system Owner
 *            bundle, and its email/password login retired — the owner account
 *            is not a login identity). Adopting rather than creating avoids the
 *            unique {venueId, phone} collision AND keeps every lead, task and
 *            follow-up already pointing at that id.
 *
 * Nothing is ever deleted, and no owner row is created for a deactivated owner.
 *
 * SAFETY: refuses to run against a non-local Mongo UNLESS the operator
 * deliberately opts in with BOTH `ALLOW_REMOTE=1` and `--apply` (the guarded
 * production path — MB-V2 P3). Local hosts (127.0.0.1/localhost) always allowed.
 * The resolved host is printed prominently on every run.
 *
 * Usage:
 *   node scripts/migrate-owner-members.js                        # local dry-run (default)
 *   node scripts/migrate-owner-members.js --apply                # local backfill
 *   ALLOW_REMOTE=1 node scripts/migrate-owner-members.js --apply # PROD run (both gates required)
 */
require("dotenv").config();
const mongoose = require("mongoose");
const VenueOwner = require("../models/VenueOwner");
const VenueTeamMember = require("../models/VenueTeamMember");
const { ensureOwnerMember } = require("../utils/venueOwnerMember");

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
  console.log(`[migrate-owner-members] ┌───────────────────────────────────────────`);
  console.log(`[migrate-owner-members] │ TARGET HOST: ${host}  (${isLocal ? "local" : "REMOTE"})`);
  console.log(`[migrate-owner-members] │ MODE: ${APPLY ? "APPLY" : "DRY-RUN"}  ALLOW_REMOTE=${ALLOW_REMOTE ? "1" : "0"}`);
  console.log(`[migrate-owner-members] └───────────────────────────────────────────`);
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
    `[migrate-owner-members] ⚠  REMOTE APPLY authorized (ALLOW_REMOTE=1 + --apply) — writing to ${host}`
  );
  return host;
}

// Classify what WOULD happen to one owner, without writing anything. Mirrors
// ensureOwnerMember's own precedence: existing row → adopt by phone → create.
async function classify(owner) {
  const existing = await VenueTeamMember.findOne({
    venueId: owner.venueId,
    ownerId: owner._id,
    isOwnerAccount: true,
  })
    .select("_id")
    .lean();
  if (existing) return { action: "skip", detail: `already has owner row ${existing._id}` };

  const byPhone = await VenueTeamMember.findOne({
    venueId: owner.venueId,
    phone: owner.phone,
    isOwnerAccount: { $ne: true },
  })
    .select("_id name email")
    .lean();
  if (byPhone) {
    const loses = byPhone.email ? ` (retires member login ${byPhone.email})` : "";
    return { action: "adopt", detail: `adopt self-invited member ${byPhone._id} "${byPhone.name}"${loses}` };
  }
  return { action: "create", detail: `create owner row for "${owner.name}"` };
}

async function run() {
  const host = assertMongoTarget();
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 8000 });
  console.log(`[migrate-owner-members] connected to Mongo @ ${host} (${APPLY ? "APPLY" : "DRY-RUN"})`);

  const owners = await VenueOwner.find({ isActive: { $ne: false } })
    .select("_id name phone venueId")
    .lean();
  const skippedInactive = await VenueOwner.countDocuments({ isActive: false });
  console.log(
    `[migrate-owner-members] ${owners.length} active owner account(s); ${skippedInactive} inactive owner(s) skipped`
  );

  const tally = { create: 0, adopt: 0, skip: 0, failed: 0 };
  for (const owner of owners) {
    let plan;
    try {
      plan = await classify(owner);
    } catch (err) {
      tally.failed++;
      console.error(`  ✗ owner ${owner._id} (venue ${owner.venueId}): classify failed — ${err.message}`);
      continue;
    }
    tally[plan.action]++;
    if (plan.action !== "skip") {
      console.log(`  ${APPLY ? plan.action.toUpperCase() : "would " + plan.action} — venue ${owner.venueId}: ${plan.detail}`);
    }
    if (!APPLY || plan.action === "skip") continue;
    try {
      const id = await ensureOwnerMember(owner.venueId, owner._id);
      if (!id) {
        tally.failed++;
        console.error(`  ✗ owner ${owner._id}: ensure returned no row`);
      }
    } catch (err) {
      tally.failed++;
      console.error(`  ✗ owner ${owner._id}: ensure failed — ${err.message}`);
    }
  }

  console.log(
    `[migrate-owner-members] ${APPLY ? "created" : "would create"} ${tally.create}, ` +
      `${APPLY ? "adopted" : "would adopt"} ${tally.adopt}, already present ${tally.skip}, failed ${tally.failed}`
  );
  if (!APPLY) {
    console.log("[migrate-owner-members] DRY-RUN — no changes written. Re-run with --apply to backfill.");
  } else {
    const total = await VenueTeamMember.countDocuments({ isOwnerAccount: true });
    console.log(`[migrate-owner-members] ${total} owner account row(s) now exist across all venues.`);
  }

  await mongoose.disconnect();
  console.log("[migrate-owner-members] DONE");
  if (tally.failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error(`[migrate-owner-members] FAILED: ${err.message}`);
  process.exit(1);
});
