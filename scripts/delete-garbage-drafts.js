require("dotenv").config();
const mongoose = require("mongoose");
const Venue = require("../models/Venue");

const URI = process.env.MONGODB_ATLAS_URL || process.env.DATABASE_URL;
if (!URI) {
  console.error("MONGODB_ATLAS_URL or DATABASE_URL must be set");
  process.exit(1);
}

// `{ $in: ["", null] }` in Mongo also matches fields that don't exist — null
// equality is field-presence-blind. So this single predicate covers all three
// "no real value" cases: empty string, explicit null, or missing entirely.
const GARBAGE_QUERY = {
  status: "draft",
  address: { $in: ["", null] },
  coverPhoto: { $in: ["", null] },
};

(async () => {
  await mongoose.connect(URI);

  const candidates = await Venue.find(GARBAGE_QUERY).select("slug name").lean();
  console.log(`Found ${candidates.length} garbage-draft candidates to delete.\n`);
  candidates.forEach((v, i) => {
    console.log(`  ${String(i + 1).padStart(3, " ")}. ${v.slug}${v.name ? `  (${v.name})` : ""}`);
  });

  if (candidates.length === 0) {
    console.log("\nNothing to delete.");
    await mongoose.disconnect();
    return;
  }

  const result = await Venue.deleteMany(GARBAGE_QUERY);
  console.log(`\nDeleted ${result.deletedCount} venues.`);

  const newTotal = await Venue.countDocuments({});
  console.log(`New total venue count: ${newTotal}`);

  await mongoose.disconnect();
})().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
