/**
 * Verify VenueService.createVenue at the SERVICE layer (LOCAL DEV ONLY).
 * Proves: (a) creates with status "draft" + a slug, (b) a second call with the
 * SAME name yields a DIFFERENT unique slug (no crash on duplicate). Deletes the
 * two test docs on exit. Aborts if DATABASE_URL is not localhost.
 *
 * Run: node scripts/verify-create-venue.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const VenueService = require("../services/VenueService");
const Venue = require("../models/Venue");

const dbUrl = process.env.DATABASE_URL || "";
if (!dbUrl.startsWith("mongodb://localhost")) {
  console.error("ABORT: DATABASE_URL is not localhost.");
  console.error(`DATABASE_URL = ${dbUrl || "(empty)"}`);
  process.exit(1);
}

(async () => {
  const ids = [];
  try {
    await mongoose.connect(dbUrl);
    console.log(`Connected to ${dbUrl}\n`);

    // Same name for both calls — fresh base so v1 gets the clean slug, v2 the -2 suffix.
    const name = `Verify Create Venue ${Date.now()}`;

    const v1 = await VenueService.createVenue({ name, venueType: "resort" });
    ids.push(v1._id);
    console.log("v1:", { _id: String(v1._id), slug: v1.slug, status: v1.status });

    const v2 = await VenueService.createVenue({ name, venueType: "resort" });
    ids.push(v2._id);
    console.log("v2:", { _id: String(v2._id), slug: v2.slug, status: v2.status });

    console.log("");
    console.log("PASS v1 status is 'draft' :", v1.status === "draft");
    console.log("PASS v1 has a slug        :", !!v1.slug);
    console.log("PASS v2 status is 'draft' :", v2.status === "draft");
    console.log("PASS v2 has a slug        :", !!v2.slug);
    console.log("PASS slugs are DIFFERENT  :", v1.slug !== v2.slug);
    console.log("PASS v1 has _id           :", !!v1._id);
    console.log("PASS v2 has _id           :", !!v2._id);
  } catch (e) {
    console.error("ERROR:", e.message);
    process.exitCode = 1;
  } finally {
    if (ids.length) {
      const r = await Venue.deleteMany({ _id: { $in: ids } }).catch(() => ({ deletedCount: 0 }));
      console.log(`\nCleaned up ${r.deletedCount} test venue(s).`);
    }
    await mongoose.disconnect();
    console.log("Disconnected.");
  }
})();
