require("dotenv").config();
const mongoose = require("mongoose");
const Venue = require("../models/Venue");

const URI = process.env.MONGODB_ATLAS_URL || process.env.DATABASE_URL;
if (!URI) {
  console.error("No MONGODB_ATLAS_URL or DATABASE_URL set");
  process.exit(1);
}

const HOTEL_CHAINS = [
  "taj",
  "itc",
  "marriott",
  "radisson",
  "sheraton",
  "leela",
  "oberoi",
  "hyatt",
  "hilton",
  "westin",
  "novotel",
  "holiday inn",
  "courtyard",
  "vivanta",
  "trident",
];

(async () => {
  await mongoose.connect(URI);

  // Build a case-insensitive regex of all chain names joined with | — escape spaces literally.
  const escaped = HOTEL_CHAINS.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(escaped.join("|"), "i");

  const candidates = await Venue.find({
    venueType: "resort",
    name: { $regex: pattern },
  }).select("_id name venueType").lean();

  console.log(`Found ${candidates.length} resort venues whose names match a hotel chain.`);
  candidates.forEach((v) => console.log(`  - ${v.name}`));

  if (candidates.length === 0) {
    await mongoose.disconnect();
    return;
  }

  const ids = candidates.map((v) => v._id);
  const res = await Venue.updateMany(
    { _id: { $in: ids } },
    { $set: { venueType: "hotel" } }
  );

  console.log(`\nUpdated ${res.modifiedCount} venue(s) from resort -> hotel.`);

  await mongoose.disconnect();
})().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
