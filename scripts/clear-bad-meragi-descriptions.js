require("dotenv").config();
const mongoose = require("mongoose");
const Venue = require("../models/Venue");

const URI = process.env.MONGODB_ATLAS_URL || process.env.DATABASE_URL;
if (!URI) {
  console.error("No MONGODB_ATLAS_URL or DATABASE_URL set");
  process.exit(1);
}

// Phrases that prove the description is page-chrome rather than the venue
// blurb. Any one of these in a >500-char description scoped to a Meragi venue
// means we caught the full-page-text bug from the old scraper.
const BAD_PHRASES_RE = /Home Venues Destinations|Privacy Policy|Meragi Events/i;

(async () => {
  await mongoose.connect(URI);

  // scrapedFrom is an array — $in matches if ANY element equals "Meragi".
  // Match both capitalizations defensively in case past runs lowercased it.
  const query = {
    scrapedFrom: { $in: ["Meragi", "meragi"] },
    $expr: { $gt: [{ $strLenCP: { $ifNull: ["$description", ""] } }, 500] },
    description: { $regex: BAD_PHRASES_RE },
  };

  const candidates = await Venue.find(query).select("_id slug name description").lean();
  console.log(`Found ${candidates.length} Meragi venues with bad descriptions.`);
  candidates.forEach((v) => {
    console.log(`  - ${v.slug}  (descLen=${(v.description || "").length})`);
  });

  if (candidates.length === 0) {
    console.log("\nNothing to clear.");
    await mongoose.disconnect();
    return;
  }

  const result = await Venue.updateMany(
    { _id: { $in: candidates.map((v) => v._id) } },
    { $set: { description: "" } }
  );

  console.log(`\nCleared description on ${result.modifiedCount} venue${result.modifiedCount === 1 ? "" : "s"}.`);
  console.log(`(matched=${result.matchedCount}, modified=${result.modifiedCount})`);

  await mongoose.disconnect();
})().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
