require("dotenv").config();
const mongoose = require("mongoose");
const Venue = require("../models/Venue");

const URI = process.env.MONGODB_ATLAS_URL || process.env.DATABASE_URL;
if (!URI) {
  console.error("MONGODB_ATLAS_URL or DATABASE_URL must be set");
  process.exit(1);
}

// Promote drafts that meet the basic-listing bar: name, address, coverPhoto
// are all present. Everything else (pricing, amenities, etc.) is optional —
// the user-facing page degrades gracefully when fields are missing.
const QUERY = {
  status: "draft",
  name: { $exists: true, $nin: ["", null] },
  address: { $exists: true, $nin: ["", null] },
  coverPhoto: { $exists: true, $nin: ["", null] },
};

(async () => {
  await mongoose.connect(URI);

  const candidates = await Venue.find(QUERY).select("slug name").lean();
  console.log(`Found ${candidates.length} draft venues that meet the publish bar.\n`);
  if (candidates.length === 0) {
    console.log("Nothing to publish.");
    await mongoose.disconnect();
    return;
  }
  candidates.forEach((v, i) => {
    console.log(`  ${String(i + 1).padStart(3, " ")}. ${v.slug}`);
  });

  const result = await Venue.updateMany(QUERY, { $set: { status: "published" } });
  console.log(`\nPublished ${result.modifiedCount} of ${result.matchedCount} matched venues.`);

  await mongoose.disconnect();
})().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
