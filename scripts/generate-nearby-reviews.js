require("dotenv").config();
const mongoose = require("mongoose");
const Venue = require("../models/Venue");

const URI = process.env.MONGODB_ATLAS_URL || process.env.DATABASE_URL;
if (!URI) {
  console.error("No MONGODB_ATLAS_URL or DATABASE_URL set");
  process.exit(1);
}

const BASE_URL = process.env.LOCAL_SERVER_URL || "http://localhost:8090";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SEVEN_DAYS_AGO = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

(async () => {
  await mongoose.connect(URI);

  // ---------- Pass 1: nearby accommodation ----------
  const nearbyStale = await Venue.find({
    "location.coordinates.0": { $exists: true },
    $or: [
      { nearbyAccommodationRefreshedAt: { $exists: false } },
      { nearbyAccommodationRefreshedAt: { $lt: SEVEN_DAYS_AGO } },
    ],
  })
    .select("_id slug nearbyAccommodationRefreshedAt")
    .lean();

  console.log(`\n=== PASS 1: nearby accommodation (${nearbyStale.length} venues) ===\n`);

  let nearbyOk = 0;
  let nearbyErr = 0;
  const nearbyFailed = [];

  for (let i = 0; i < nearbyStale.length; i++) {
    const v = nearbyStale[i];
    const idx = `[${i + 1}/${nearbyStale.length}]`;
    try {
      const res = await fetch(`${BASE_URL}/venues/${v.slug}/nearby`, {
        method: "POST",
      });
      if (res.ok) {
        nearbyOk++;
        console.log(`${idx} nearby ${v.slug} → ok`);
      } else {
        nearbyErr++;
        nearbyFailed.push(v.slug);
        console.log(`${idx} nearby ${v.slug} → ${res.status}`);
      }
    } catch (err) {
      nearbyErr++;
      nearbyFailed.push(v.slug);
      console.log(`${idx} nearby ${v.slug} → ${err.message}`);
    }
    await sleep(500);
  }

  // ---------- Pass 2: Google reviews ----------
  const reviewsStale = await Venue.find({
    googlePlaceId: { $exists: true, $nin: ["", null] },
    $or: [
      { googleReviewsRefreshedAt: { $exists: false } },
      { googleReviewsRefreshedAt: { $lt: SEVEN_DAYS_AGO } },
    ],
  })
    .select("_id slug googlePlaceId googleReviewsRefreshedAt")
    .lean();

  console.log(`\n=== PASS 2: Google reviews (${reviewsStale.length} venues) ===\n`);

  let reviewsOk = 0;
  let reviewsErr = 0;
  const reviewsFailed = [];

  for (let i = 0; i < reviewsStale.length; i++) {
    const v = reviewsStale[i];
    const idx = `[${i + 1}/${reviewsStale.length}]`;
    try {
      const res = await fetch(`${BASE_URL}/venues/${v.slug}/reviews`, {
        method: "POST",
      });
      if (res.ok) {
        reviewsOk++;
        console.log(`${idx} reviews ${v.slug} → ok`);
      } else {
        reviewsErr++;
        reviewsFailed.push(v.slug);
        console.log(`${idx} reviews ${v.slug} → ${res.status}`);
      }
    } catch (err) {
      reviewsErr++;
      reviewsFailed.push(v.slug);
      console.log(`${idx} reviews ${v.slug} → ${err.message}`);
    }
    await sleep(500);
  }

  // ---------- Summary ----------
  console.log("\n=== SUMMARY ===");
  console.log(`Nearby refresh: ${nearbyOk} updated, ${nearbyErr} errors`);
  console.log(`Reviews refresh: ${reviewsOk} updated, ${reviewsErr} errors`);

  if (nearbyFailed.length || reviewsFailed.length) {
    console.log("\nFailed slugs:");
    if (nearbyFailed.length) {
      console.log("  nearby:");
      nearbyFailed.forEach((s) => console.log(`    - ${s}`));
    }
    if (reviewsFailed.length) {
      console.log("  reviews:");
      reviewsFailed.forEach((s) => console.log(`    - ${s}`));
    }
  }
  console.log("");

  await mongoose.disconnect();
})().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
