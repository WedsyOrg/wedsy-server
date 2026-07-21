/**
 * scripts/verify-coverphoto-guard.js
 *
 * Verifies the Venue.coverPhoto durability guard (models/Venue.js): it must
 * REJECT raw keyed Google Places Photo URLs and ACCEPT every durable URL shape
 * the live catalogue actually uses.
 *
 * Read-only and offline: exercises the validator and the update-query hook
 * against an unconnected model. Touches no database, issues no HTTP.
 *
 * Usage: node scripts/verify-coverphoto-guard.js
 */
const mongoose = require("mongoose");
const Venue = require("../models/Venue");

// Real shapes taken from the live coverPhoto host distribution.
const SHOULD_PASS = [
  ["", "schema default (empty)"],
  ["https://lh3.googleusercontent.com/place-photos/AJRVUZOUI5qclseWhkTh08UQVY_d2Dh=s4800-w1600", "lh3 place-photos (the 27 good covers)"],
  ["https://lh3.googleusercontent.com/gps-cs-s/APNQkAGZTc6Y7lG9lWLTni3_gkMxS0dS=s1600-w1600", "lh3 gps-cs-s variant"],
  ["https://image.wedmegood.com/resized/800X/uploads/member/123/cover.jpeg", "image.wedmegood.com (204 venues)"],
  ["https://images.wedmegood.com/resized/800X/uploads/x.jpg", "images.wedmegood.com"],
  ["https://d1p55htxo8z8mf.cloudfront.net/venues/abc.jpg", "cloudfront (19 venues)"],
  ["https://meragi-cms.s3.ap-south-1.amazonaws.com/venue/xyz.jpg", "meragi S3 (49 venues)"],
  ["https://gcpimages.theweddingcompany.com/venue/1.jpg", "theweddingcompany (20 venues)"],
];

const SHOULD_REJECT = [
  ["https://maps.googleapis.com/maps/api/place/photo?maxwidth=1200&photo_reference=Ab43m-x&key=AIzaDEAD", "the exact broken shape (46 venues)"],
  ["https://maps.googleapis.com/maps/api/place/photo?maxwidth=800&photo_reference=Y&key=LIVE", "same shape, live key — still forbidden"],
  ["http://maps.googleapis.com/maps/api/place/photo?photo_reference=Z", "http, no key — still the redirector"],
  ["HTTPS://MAPS.GOOGLEAPIS.COM/maps/api/place/photo?key=A", "uppercase host (case-insensitivity)"],
];

let failures = 0;

function check(desc, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "*** FAIL ***"}  ${desc}`);
}

// --- 1. Path validator (fires on save()/create()) ---
console.log("\n[1] path validator — document save() path");
for (const [url, desc] of SHOULD_PASS) {
  const err = new Venue({ name: "T", slug: "t", coverPhoto: url }).validateSync();
  check(`accepts ${desc}`, !err || !err.errors.coverPhoto, true);
}
for (const [url, desc] of SHOULD_REJECT) {
  const err = new Venue({ name: "T", slug: "t", coverPhoto: url }).validateSync();
  check(`rejects ${desc}`, !!(err && err.errors.coverPhoto), true);
}

// --- 2. Update-query hook (fires on updateOne/updateMany/findOneAndUpdate) ---
// This is the path an ad-hoc script uses, and the one a plain path validator
// would silently skip.
console.log("\n[2] update-query hook — updateOne/$set path (the ad-hoc-script route)");

// Invoke the exact function registered as the updateOne/updateMany/
// findOneAndUpdate/replaceOne pre-hook, with the `this` Mongoose gives it.
// Returns the Error it passed to next(), or null when it allowed the update.
function runHook(update) {
  let captured = null;
  Venue.__guardCoverPhotoUpdate.call({ getUpdate: () => update }, (e) => {
    if (e) captured = e;
  });
  return captured;
}

for (const [url, desc] of SHOULD_PASS.filter(([u]) => u !== "")) {
  check(`$set accepts ${desc}`, runHook({ $set: { coverPhoto: url } }) === null, true);
}
for (const [url, desc] of SHOULD_REJECT) {
  check(`$set rejects ${desc}`, runHook({ $set: { coverPhoto: url } }) !== null, true);
  check(`bare-field rejects ${desc}`, runHook({ coverPhoto: url }) !== null, true);
}

// Updates that do not carry coverPhoto must pass through untouched.
console.log("\n[3] non-coverPhoto updates are unaffected");
check("unrelated $set passes", runHook({ $set: { name: "New Name", zone: "north" } }) === null, true);
check("empty-ish update passes", runHook({ $set: {} }) === null, true);
check("$unset passes", runHook({ $unset: { tagline: "" } }) === null, true);

console.log(
  failures === 0
    ? "\n✅ ALL GUARD CHECKS PASSED — rejects the broken shape, accepts every live catalogue host.\n"
    : `\n❌ ${failures} GUARD CHECK(S) FAILED\n`
);
process.exit(failures === 0 ? 0 : 1);
