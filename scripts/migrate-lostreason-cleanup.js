/**
 * scripts/migrate-lostreason-cleanup.js
 *
 * Unset VenueEnquiry.lostReason on docs where it is the empty string "".
 * Phase 3 tightened lostReason to an enum (with "" tolerated for legacy data);
 * this removes the noisy empty-string values so only real reasons remain.
 *
 * SAFETY: refuses to run unless DATABASE_URL points at a local Mongo host
 * (same guard as scripts/seed-test-venue.js).
 *
 * Usage:
 *   node scripts/migrate-lostreason-cleanup.js           # dry-run (default)
 *   node scripts/migrate-lostreason-cleanup.js --apply   # perform the $unset
 */
require("dotenv").config();
const mongoose = require("mongoose");
const VenueEnquiry = require("../models/VenueEnquiry");

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
  console.log(`[migrate-lostreason] connected to local Mongo @ ${host} (${APPLY ? "APPLY" : "DRY-RUN"})`);

  const filter = { lostReason: "" };
  const count = await VenueEnquiry.countDocuments(filter);
  console.log(`[migrate-lostreason] ${count} enquiries have lostReason === ""`);

  if (!APPLY) {
    console.log("[migrate-lostreason] DRY-RUN — no changes written. Re-run with --apply to unset them.");
  } else if (count > 0) {
    const res = await VenueEnquiry.updateMany(filter, { $unset: { lostReason: "" } });
    console.log(`[migrate-lostreason] unset lostReason on ${res.modifiedCount} enquiries.`);
  } else {
    console.log("[migrate-lostreason] nothing to do.");
  }

  await mongoose.disconnect();
  console.log("[migrate-lostreason] DONE");
}

run().catch(async (err) => {
  console.error("[migrate-lostreason] FAILED:", err.message);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
