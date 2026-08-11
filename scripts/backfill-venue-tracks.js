/**
 * scripts/backfill-venue-tracks.js — MB-OSV S0 data migration.
 *
 * Moves verification off the conflated Venue.status and onto the Track A
 * boolean, and classifies each venue's entry point. Idempotent: safe to run
 * repeatedly, and a second run reports zero changes.
 *
 *   node scripts/backfill-venue-tracks.js          # dry run (default)
 *   node scripts/backfill-venue-tracks.js --apply  # write
 *
 * WHAT IT DOES
 *   1. status === "verified"        → verified.isVerified = true
 *      Everything else with no verified.isVerified → false.
 *      `status` is LEFT ALONE. Rewriting a live listing's publication state is
 *      a product decision, not a migration's call; the legacy value stays
 *      readable and utils/venueTracks stops depending on it once the boolean
 *      exists. Retiring the enum value is a separate, deliberate change.
 *
 *   2. entryPoint — "" for rows that already have one; otherwise
 *      claimed  (an active VenueOwner exists)
 *      scraped  (scrapedFrom non-empty / a googlePlaceId is set)
 *      walk_up  (neither — someone typed it in)
 *
 *   3. partner.firstOwnerLoginAt — seeded from the earliest VenueOwner
 *      lastLoginAt we know about, so venues whose owners signed in BEFORE this
 *      field existed are not misreported as "granted, never logged in".
 *      Only for venues that already have partner.accessGrantedAt; without a
 *      grant there is no Track B to backdate.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueOwner = require("../models/VenueOwner");

const APPLY = process.argv.includes("--apply");

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  console.log(`[backfill-venue-tracks] ${APPLY ? "APPLY" : "DRY RUN"} on ${mongoose.connection.name}`);

  const venues = await Venue.find({}).select("_id name slug status verified entryPoint scrapedFrom googlePlaceId partner").lean();
  const owners = await VenueOwner.find({ isActive: true }).select("venueId lastLoginAt").lean();

  const ownersByVenue = new Map();
  for (const o of owners) {
    const k = String(o.venueId);
    const prev = ownersByVenue.get(k);
    // Earliest known login wins — that is the closest thing we have to "first".
    if (!prev || (o.lastLoginAt && prev.lastLoginAt && o.lastLoginAt < prev.lastLoginAt) || (!prev.lastLoginAt && o.lastLoginAt)) {
      ownersByVenue.set(k, o);
    } else if (!prev) {
      ownersByVenue.set(k, o);
    }
  }

  const counts = { verifiedTrue: 0, verifiedFalse: 0, entryPoint: 0, seededLogin: 0, unchanged: 0 };
  const ops = [];

  for (const v of venues) {
    const set = {};
    const hasVerified = v.verified && typeof v.verified.isVerified === "boolean";
    if (!hasVerified) {
      const isVerified = v.status === "verified";
      set["verified.isVerified"] = isVerified;
      if (isVerified) counts.verifiedTrue++;
      else counts.verifiedFalse++;
    }

    if (!v.entryPoint) {
      const owner = ownersByVenue.get(String(v._id));
      const scraped = (Array.isArray(v.scrapedFrom) && v.scrapedFrom.length > 0) || Boolean(v.googlePlaceId);
      set.entryPoint = owner ? "claimed" : scraped ? "scraped" : "walk_up";
      counts.entryPoint++;
    }

    const p = v.partner || {};
    if (p.accessGrantedAt && !p.firstOwnerLoginAt) {
      const owner = ownersByVenue.get(String(v._id));
      if (owner && owner.lastLoginAt) {
        set["partner.firstOwnerLoginAt"] = owner.lastLoginAt;
        counts.seededLogin++;
      }
    }

    if (Object.keys(set).length === 0) {
      counts.unchanged++;
      continue;
    }
    ops.push({ updateOne: { filter: { _id: v._id }, update: { $set: set } } });
  }

  console.log(`  venues scanned        : ${venues.length}`);
  console.log(`  verified.isVerified=T : ${counts.verifiedTrue}`);
  console.log(`  verified.isVerified=F : ${counts.verifiedFalse}`);
  console.log(`  entryPoint classified : ${counts.entryPoint}`);
  console.log(`  firstOwnerLogin seeded: ${counts.seededLogin}`);
  console.log(`  already current       : ${counts.unchanged}`);
  console.log(`  documents to write    : ${ops.length}`);

  if (APPLY && ops.length) {
    // bulkWrite with updateOne bypasses the coverPhoto update guard's concern
    // (no coverPhoto in any payload here) and never triggers a full save().
    const r = await Venue.bulkWrite(ops, { ordered: false });
    console.log(`  → modified ${r.modifiedCount} document(s)`);
  } else if (!APPLY) {
    console.log("  (dry run — pass --apply to write)");
  }

  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
