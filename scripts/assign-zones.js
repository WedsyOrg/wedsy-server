require("dotenv").config();
const mongoose = require("mongoose");
const Venue = require("../models/Venue");

const URI = process.env.MONGODB_ATLAS_URL || process.env.DATABASE_URL;
if (!URI) {
  console.error("MONGODB_ATLAS_URL or DATABASE_URL must be set");
  process.exit(1);
}

// Coordinate-based zone classifier. Order matters: airport (north of 13.08)
// is checked before the more general "north" band so far-north Devanahalli
// venues get their own bucket.
function zoneFromCoords(lng, lat) {
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (lat > 13.08) return "airport";
  if (lat > 13.02 && lat <= 13.08) return "north";
  if (lng > 77.70) return "east";
  if (lat < 12.87) return "south";
  if (lng < 77.50) return "west";
  return "central";
}

// Address-based fallback for venues without coordinates. Word-level matches —
// the test regex uses word boundaries to avoid e.g. "north" matching "northwest".
const ADDRESS_RULES = [
  { zone: "airport", re: /\b(devanahalli|bagalur|kogilu)\b/i },
  { zone: "north",   re: /\b(yelahanka|jakkur|hebbal|thanisandra)\b/i },
  { zone: "east",    re: /\b(whitefield|marathahalli|sarjapur|varthur|brookefield)\b/i },
  { zone: "south",   re: /\b(bannerghatta|electronic\s+city|jigani|kanakapura|anekal)\b/i },
  { zone: "west",    re: /\b(magadi|tumkur|rajajinagar|yeshwanthpur)\b/i },
];

function zoneFromAddress(address) {
  if (!address) return "central";
  for (const { zone, re } of ADDRESS_RULES) {
    if (re.test(address)) return zone;
  }
  return "central";
}

(async () => {
  await mongoose.connect(URI);

  const venues = await Venue.find({})
    .select("_id slug address location zone")
    .lean();

  console.log(`Processing ${venues.length} venues…\n`);

  const tally = { airport: 0, north: 0, east: 0, south: 0, west: 0, central: 0 };
  let coordBased = 0;
  let addressBased = 0;
  let updated = 0;
  let unchanged = 0;
  let errors = 0;

  for (const v of venues) {
    let zone;
    const coords = v.location?.coordinates;
    if (Array.isArray(coords) && coords.length === 2) {
      zone = zoneFromCoords(coords[0], coords[1]);
      if (zone) coordBased++;
    }
    if (!zone) {
      zone = zoneFromAddress(v.address);
      addressBased++;
    }

    tally[zone] = (tally[zone] || 0) + 1;

    if (v.zone === zone) {
      unchanged++;
      continue;
    }
    try {
      await Venue.updateOne({ _id: v._id }, { $set: { zone } });
      updated++;
    } catch (err) {
      console.warn(`  ✗ ${v.slug}: ${err.message}`);
      errors++;
    }
  }

  console.log("Source breakdown:");
  console.log(`  coords  → ${coordBased}`);
  console.log(`  address → ${addressBased}`);
  console.log("\nZone counts (post-update):");
  Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .forEach(([z, n]) => console.log(`  ${z.padEnd(8, " ")} ${n}`));
  console.log(`\nUpdated: ${updated}, unchanged: ${unchanged}, errors: ${errors}`);
  console.log(`Total processed: ${venues.length}`);

  await mongoose.disconnect();
})().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
