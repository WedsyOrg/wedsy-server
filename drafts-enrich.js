require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');

const KEY = process.env.GOOGLE_PLACES_API_KEY;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPlace(name) {
  const url =
    `https://maps.googleapis.com/maps/api/place/findplacefromtext/json` +
    `?input=${encodeURIComponent(name + ' Bangalore')}` +
    `&inputtype=textquery` +
    `&fields=place_id,geometry,formatted_address,photos,rating,user_ratings_total` +
    `&key=${KEY}`;
  const { data } = await axios.get(url, { timeout: 15000 });
  if (data.status !== 'OK') return null;
  return (data.candidates && data.candidates[0]) || null;
}

// Google's /photo endpoint returns a 302 redirect to the actual image URL.
// axios with maxRedirects:0 lets us capture the Location header.
async function resolvePhotoUrl(photoReference) {
  const url =
    `https://maps.googleapis.com/maps/api/place/photo?maxwidth=1600` +
    `&photo_reference=${encodeURIComponent(photoReference)}&key=${KEY}`;
  try {
    const res = await axios.get(url, {
      maxRedirects: 0,
      validateStatus: (s) => s >= 200 && s < 400,
    });
    return (res.headers && res.headers.location) || null;
  } catch (e) {
    if (e.response && e.response.headers && e.response.headers.location) {
      return e.response.headers.location;
    }
    return null;
  }
}

(async () => {
  if (!KEY) { console.error('GOOGLE_PLACES_API_KEY not set'); process.exit(1); }
  await mongoose.connect(process.env.MONGODB_ATLAS_URL || process.env.DATABASE_URL);
  const Venue = require('./models/Venue');

  // ── TASK 1 — delete city-name placeholders ──
  const cityNames = ['Mumbai', 'Bangalore', 'Pune', 'Kolkata', 'Jaipur', 'Lucknow', 'Hyderabad'];
  const delResult = await Venue.deleteMany({
    name: { $in: cityNames.map((n) => new RegExp(`^${n}$`, 'i')) },
  });
  console.log(`TASK 1 — deleted ${delResult.deletedCount} city-name venues`);

  // ── TASK 2 — enrich remaining drafts via Google Places ──
  const drafts = await Venue.find({
    status: 'draft',
    name: { $exists: true, $ne: '', $not: /crown\s*estate/i },
  }).lean();
  console.log(`TASK 2 — ${drafts.length} drafts to enrich`);

  let enriched = 0;
  let published = 0;
  let errors = 0;
  let noMatch = 0;

  for (const v of drafts) {
    try {
      const cand = await findPlace(v.name);
      if (!cand) {
        noMatch++;
        console.log(`  ✗ ${v.name}: no Google match`);
        await sleep(300);
        continue;
      }

      const update = {};
      if (cand.formatted_address && !v.address) update.address = cand.formatted_address;
      if (cand.geometry && cand.geometry.location) {
        const { lng, lat } = cand.geometry.location;
        update.location = { type: 'Point', coordinates: [lng, lat] };
      }
      if (cand.place_id) update.googlePlaceId = cand.place_id;
      if (typeof cand.rating === 'number') update.googleRating = cand.rating;
      if (typeof cand.user_ratings_total === 'number') update.googleReviewCount = cand.user_ratings_total;

      if (!v.coverPhoto && Array.isArray(cand.photos) && cand.photos[0] && cand.photos[0].photo_reference) {
        const photoUrl = await resolvePhotoUrl(cand.photos[0].photo_reference);
        if (photoUrl) update.coverPhoto = photoUrl;
      }

      const finalAddress = update.address || v.address;
      const finalCover = update.coverPhoto || v.coverPhoto;
      const shouldPublish = !!(v.name && (finalAddress || finalCover));
      if (shouldPublish) update.status = 'published';

      await Venue.updateOne({ _id: v._id }, { $set: update });
      enriched++;
      if (shouldPublish) published++;
      const flags = [
        update.address ? 'addr' : null,
        update.coverPhoto ? 'photo' : null,
        update.googleRating != null ? `★${update.googleRating}` : null,
        shouldPublish ? 'PUBLISHED' : null,
      ].filter(Boolean).join(' ');
      console.log(`  ✓ ${v.name} — ${flags}`);
    } catch (e) {
      errors++;
      console.log(`  ✗ ${v.name}: ${e.message}`);
    }
    await sleep(300);
  }

  console.log(`\n── SUMMARY ──`);
  console.log(`  Deleted:   ${delResult.deletedCount}`);
  console.log(`  Enriched:  ${enriched}`);
  console.log(`  Published: ${published}`);
  console.log(`  No match:  ${noMatch}`);
  console.log(`  Errors:    ${errors}`);

  await mongoose.disconnect();
})();
