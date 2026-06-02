/**
 * Seed the Stage collection with the current 3 CRM stages. LOCAL DEV ONLY.
 * Idempotent: upserts by slug, won't duplicate on re-run. Run: node scripts/seed-stages.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Stage = require("../models/Stage");

const dbUrl = process.env.DATABASE_URL || "";
if (!dbUrl.startsWith("mongodb://localhost")) {
  console.error("ABORT: DATABASE_URL is not localhost."); process.exit(1);
}
const SEED = [
  { name: "New", slug: "new", order: 0, color: "#4B1528", category: "open", isSystem: true },
  { name: "Contacted", slug: "contacted", order: 1, color: "#8B5A00", category: "open", isSystem: false },
  { name: "Meeting Scheduled", slug: "meeting_scheduled", order: 2, color: "#2D5F3F", category: "open", isSystem: false },
  { name: "Lost", slug: "lost", order: 99, color: "#8B0000", category: "lost", isSystem: true },
];
(async () => {
  await mongoose.connect(dbUrl);
  for (const s of SEED) {
    await Stage.updateOne({ slug: s.slug }, { $set: s }, { upsert: true });
    console.log("upserted:", s.slug);
  }
  const count = await Stage.countDocuments({ deletedAt: null });
  console.log("total stages:", count);
  await mongoose.disconnect();
})();
