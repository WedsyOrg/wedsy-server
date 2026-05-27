/* eslint-disable no-console */
// Batch-runs Google Places enrichment over every venue that hasn't been
// enriched in the last 7 days. Delegates the per-venue work to
// utils/enrichVenue.js so the same logic runs from the dashboard login path.
//
// Idempotent. Safe to re-run — venues processed within the window are skipped.

require("dotenv").config();
const mongoose = require("mongoose");
const Venue = require("../models/Venue");
const enrichVenue = require("../utils/enrichVenue");

const URI = process.env.MONGODB_ATLAS_URL || process.env.DATABASE_URL;
if (!URI) {
  console.error("MONGODB_ATLAS_URL or DATABASE_URL must be set");
  process.exit(1);
}
if (!process.env.GOOGLE_PLACES_API_KEY) {
  console.error("GOOGLE_PLACES_API_KEY must be set");
  process.exit(1);
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const DELAY_MS = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await mongoose.connect(URI);

  const cutoff = new Date(Date.now() - SEVEN_DAYS_MS);
  const candidates = await Venue.find({
    $or: [
      { enrichedAt: { $exists: false } },
      { enrichedAt: null },
      { enrichedAt: { $lt: cutoff } },
    ],
  })
    .select("_id slug name")
    .lean();

  console.log(`Found ${candidates.length} venue(s) to enrich (no enrichedAt or older than 7 days).\n`);
  if (candidates.length === 0) {
    await mongoose.disconnect();
    return;
  }

  let ok = 0;
  let errors = 0;
  let totalPhotos = 0;
  const zoneTally = {};
  const errorLog = [];

  for (let i = 0; i < candidates.length; i++) {
    const v = candidates[i];
    try {
      const result = await enrichVenue(v._id);
      ok++;
      if (result && result.set) {
        if (result.set.zone) {
          zoneTally[result.set.zone] = (zoneTally[result.set.zone] || 0) + 1;
        }
        if (Array.isArray(result.set.googlePhotos)) {
          totalPhotos += result.set.googlePhotos.length;
        }
      }
    } catch (err) {
      errors++;
      errorLog.push({ slug: v.slug, error: err.message });
      console.warn(`  ✗ ${v.slug}: ${err.message}`);
    }
    if ((i + 1) % 10 === 0 || i === candidates.length - 1) {
      console.log(`[${i + 1}/${candidates.length}] processed (ok=${ok}, err=${errors})`);
    }
    await sleep(DELAY_MS);
  }

  console.log("\n=== SUMMARY ===");
  console.log(`Enriched:        ${ok}`);
  console.log(`Errors:          ${errors}`);
  console.log(`Photos fetched:  ${totalPhotos}`);
  console.log("Zones assigned:");
  Object.entries(zoneTally)
    .sort((a, b) => b[1] - a[1])
    .forEach(([z, n]) => console.log(`  ${z.padEnd(8, " ")} ${n}`));
  if (errorLog.length > 0) {
    console.log("\nFailures:");
    errorLog.forEach((e) => console.log(`  - ${e.slug}: ${e.error}`));
  }

  await mongoose.disconnect();
})().catch((err) => {
  console.error("Pipeline failed:", err);
  process.exit(1);
});
