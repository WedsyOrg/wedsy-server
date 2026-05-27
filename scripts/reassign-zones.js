require("dotenv").config();
const mongoose = require("mongoose");
const Venue = require("../models/Venue");
const { localityToZone } = require("../utils/enrichVenue");

(async () => {
  await mongoose.connect(process.env.MONGODB_ATLAS_URL || process.env.DATABASE_URL);

  const venues = await Venue.find({}).select("name locality address zone").lean();

  // Count zones before
  const before = {};
  venues.forEach((v) => { before[v.zone || "unset"] = (before[v.zone || "unset"] || 0) + 1; });

  let updated = 0;
  let unchanged = 0;
  let unresolved = 0;

  for (const v of venues) {
    const newZone = localityToZone(v.locality, v.address);
    if (!newZone) { unresolved++; continue; }
    if (newZone === v.zone) { unchanged++; continue; }
    await Venue.updateOne({ _id: v._id }, { $set: { zone: newZone } });
    updated++;
  }

  // Count zones after
  const after = await Venue.aggregate([{ $group: { _id: "$zone", count: { $sum: 1 } } }]);

  console.log("=== ZONE REASSIGNMENT RESULTS ===");
  console.log("Before:", before);
  console.log("Updated:", updated, "| Unchanged:", unchanged, "| Unresolved:", unresolved);
  console.log("After:", after);

  await mongoose.disconnect();
})();
