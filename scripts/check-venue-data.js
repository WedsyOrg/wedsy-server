require("dotenv").config();
const mongoose = require("mongoose");
const Venue = require("../models/Venue");

const URI = process.env.MONGODB_ATLAS_URL || process.env.DATABASE_URL;
if (!URI) {
  console.error("No MONGODB_ATLAS_URL or DATABASE_URL set");
  process.exit(1);
}

(async () => {
  await mongoose.connect(URI);

  const total = await Venue.countDocuments({});

  const byStatusAgg = await Venue.aggregate([
    { $group: { _id: "$status", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);

  // scrapedFrom is an array — $unwind to count per source
  const byScrapedFromAgg = await Venue.aggregate([
    { $unwind: { path: "$scrapedFrom", preserveNullAndEmptyArrays: true } },
    { $group: { _id: "$scrapedFrom", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);

  const uniqueScrapedFrom = await Venue.distinct("scrapedFrom");

  const withPhotos = await Venue.countDocuments({
    coverPhoto: { $exists: true, $ne: "", $ne: null },
  });

  const withCoords = await Venue.countDocuments({
    "location.coordinates": { $exists: true, $type: "array", $not: { $size: 0 } },
  });

  console.log("\n=== VENUE DATA CHECK ===\n");
  console.log(`1. Total venues: ${total}`);
  console.log("\n2. Count by status:");
  byStatusAgg.forEach((r) => console.log(`   ${r._id ?? "(null)"}: ${r.count}`));
  console.log("\n3. Count by scrapedFrom (unwound — venues can have multiple sources):");
  byScrapedFromAgg.forEach((r) => console.log(`   ${r._id ?? "(none)"}: ${r.count}`));
  console.log("\n4. Unique scrapedFrom values:");
  console.log(`   ${JSON.stringify(uniqueScrapedFrom)}`);
  console.log(`\n5. Venues with coverPhoto: ${withPhotos} / ${total}`);
  console.log(`\n6. Venues with location.coordinates: ${withCoords} / ${total}`);
  console.log("");

  await mongoose.disconnect();
})().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
