/**
 * scripts/migrate-room-types.js
 *
 * ROOMS 2 adoption: turn a venue's hand-written marketing accommodation block
 * into real room TYPES and real ROOMS, then prove the couple-facing listing
 * renders the identical numbers.
 *
 *   accommodation.roomTypes[] (copy, with a `count`)
 *        │
 *        ├─→ roomTypes[]  one entity per row: sleeps, maxOccupancy,
 *        │                defaultRate, description, photos, amenities
 *        ├─→ rooms[]      `count` real rooms per type, named "<Type> 1..N"
 *        └─→ accommodation.roomTypes  re-DERIVED from the two above
 *
 * ── THE ACCEPTANCE TEST IS THE MIGRATION ────────────────────────────────────
 * Every venue is only migrated if the re-derived block is field-for-field equal
 * to what the listing reads today, on exactly the fields it reads:
 *
 *   wedsy-user/pages/venues/[slug].js:879-883, 940, 1686-1700
 *     rt.name, rt.count, rt.occupancyPerRoom, rt.maxPeoplePerRoom,
 *     rt.pricePerNight, rt.isAC, rt.description, rt.photos
 *     acc.available, acc.totalCapacity   (the latter also feeds
 *     VenueRepository's `capacity` sort, so it is checked too)
 *
 * A venue whose projection differs is REPORTED and SKIPPED, never forced. That
 * is the whole safety story: a mismatch means an assumption in the projection
 * is wrong for that venue, and the correct response is to look, not to write.
 *
 * SAFETY: refuses a non-local Mongo unless the operator sets BOTH ALLOW_REMOTE=1
 * and --apply. Dry-run by default. Idempotent — a venue that already has
 * roomTypes is skipped.
 *
 * Usage:
 *   node scripts/migrate-room-types.js                        # local dry-run
 *   node scripts/migrate-room-types.js --apply                # local apply
 *   ALLOW_REMOTE=1 node scripts/migrate-room-types.js --apply # PROD (both gates)
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Venue = require("../models/Venue");
const {
  DEFAULT_ROOM_AMENITIES,
  AC_KEY,
  projectAccommodation,
} = require("../utils/venueRoomTypes");

const TAG = "migrate-room-types";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);
const APPLY = process.argv.includes("--apply");
const ALLOW_REMOTE = process.env.ALLOW_REMOTE === "1";

/** Exactly the fields wedsy-user reads off a row. Nothing else is compared. */
const LISTING_ROW_FIELDS = [
  "name", "count", "occupancyPerRoom", "maxPeoplePerRoom",
  "pricePerNight", "isAC", "description", "photos",
];

function assertMongoTarget() {
  const url = process.env.DATABASE_URL || "";
  let host;
  try { host = new URL(url).hostname; }
  catch (e) { throw new Error(`Cannot parse DATABASE_URL to verify host: ${e.message}`); }
  const isLocal = LOCAL_HOSTS.has(host);
  console.log(`[${TAG}] ┌───────────────────────────────────────────`);
  console.log(`[${TAG}] │ TARGET HOST: ${host}  (${isLocal ? "local" : "REMOTE"})`);
  console.log(`[${TAG}] │ MODE: ${APPLY ? "APPLY" : "DRY-RUN"}  ALLOW_REMOTE=${ALLOW_REMOTE ? "1" : "0"}`);
  console.log(`[${TAG}] └───────────────────────────────────────────`);
  if (isLocal) return host;
  if (!ALLOW_REMOTE || !APPLY) {
    throw new Error(
      `Refusing to run: DATABASE_URL host "${host}" is REMOTE. ` +
        `The guarded production path requires BOTH ALLOW_REMOTE=1 and --apply ` +
        `(got ALLOW_REMOTE=${ALLOW_REMOTE ? "1" : "0"}, ${APPLY ? "--apply" : "no --apply"}).`
    );
  }
  console.log(`[${TAG}] ⚠  REMOTE APPLY authorized (ALLOW_REMOTE=1 + --apply) — writing to ${host}`);
  return host;
}

const n = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** Snapshot only what the listing reads, so the comparison cannot drift. */
function listingView(acc) {
  const a = acc || {};
  return {
    available: a.available === true,
    totalCapacity: n(a.totalCapacity, 0),
    rows: (a.roomTypes || []).map((r) => ({
      name: String(r.name || ""),
      count: n(r.count, 0),
      occupancyPerRoom: n(r.occupancyPerRoom, 2),
      maxPeoplePerRoom: n(r.maxPeoplePerRoom, 2),
      pricePerNight: n(r.pricePerNight, 0),
      isAC: r.isAC !== false,
      description: String(r.description || ""),
      photos: (r.photos || []).map(String),
    })),
  };
}

/**
 * The one place the listing's own derivation is reproduced, so a projection
 * that writes totalCapacity is judged against the number a couple sees TODAY
 * rather than against the stored zero.
 *   [slug].js:883  Number(acc.totalCapacity) || Σ count × (max || occupancy)
 */
function renderedCapacity(view) {
  if (view.totalCapacity) return view.totalCapacity;
  return view.rows.reduce((s, r) => s + r.count * (r.maxPeoplePerRoom || r.occupancyPerRoom || 0), 0);
}

function diffListing(before, after) {
  const out = [];
  if (before.available !== after.available) out.push(`available ${before.available} → ${after.available}`);
  const capBefore = renderedCapacity(before);
  const capAfter = renderedCapacity(after);
  if (capBefore !== capAfter) out.push(`rendered total capacity ${capBefore} → ${capAfter}`);
  if (before.rows.length !== after.rows.length) {
    out.push(`row count ${before.rows.length} → ${after.rows.length}`);
    return out;
  }
  before.rows.forEach((b, i) => {
    const a = after.rows[i];
    for (const f of LISTING_ROW_FIELDS) {
      const x = JSON.stringify(b[f]);
      const y = JSON.stringify(a[f]);
      if (x !== y) out.push(`row ${i + 1} (${b.name}) ${f}: ${x} → ${y}`);
    }
  });
  return out;
}

/** Build types + rooms on the in-memory doc. Returns a plan description. */
function planVenue(venue) {
  const rows = venue.accommodation.roomTypes;

  if (!(venue.roomAmenities || []).length) {
    venue.roomAmenities = DEFAULT_ROOM_AMENITIES.map((a) => ({ ...a, isActive: true }));
  }

  const plan = [];
  for (const row of rows) {
    const sleeps = Math.max(1, n(row.occupancyPerRoom, 2));
    venue.roomTypes.push({
      name: String(row.name || "Standard"),
      sleeps,
      // Only carry a ceiling that IS one. maxPeoplePerRoom equal to occupancy
      // means "no extra beds", and storing it as 0 lets the projection say the
      // same thing without a redundant number to keep in step.
      maxOccupancy: n(row.maxPeoplePerRoom, 0) > sleeps ? n(row.maxPeoplePerRoom, 0) : 0,
      defaultRate: n(row.pricePerNight, 0),
      description: String(row.description || ""),
      photos: (row.photos || []).map(String),
      // isAC is the only marketing flag with an amenity equivalent. Non-AC
      // becomes an empty set, not a "non-ac" amenity — the library says what a
      // room HAS.
      amenities: row.isAC !== false ? [AC_KEY] : [],
      isActive: true,
    });
    const type = venue.roomTypes[venue.roomTypes.length - 1];
    const count = Math.max(0, n(row.count, 0));
    for (let i = 1; i <= count; i += 1) {
      venue.rooms.push({
        name: `${type.name} ${i}`,
        typeRef: type._id,
        type: "standard",
        capacity: sleeps,
        amenities: type.amenities.slice(),
        rate: type.defaultRate,
        overrides: [],
        isActive: true,
      });
    }
    plan.push(`${type.name} ×${count}`);
  }
  return plan;
}

async function run() {
  const host = assertMongoTarget();
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 8000 });
  console.log(`[${TAG}] connected @ ${host}\n`);

  const total = await Venue.countDocuments({});
  const withRows = await Venue.countDocuments({ "accommodation.roomTypes.0": { $exists: true } });
  const withRooms = await Venue.countDocuments({ "rooms.0": { $exists: true } });
  const withTypes = await Venue.countDocuments({ "roomTypes.0": { $exists: true } });
  const advertising = await Venue.countDocuments({ "accommodation.available": true });

  console.log(`[${TAG}] ══ WHAT THIS DATABASE HOLDS ═══════════════════════════`);
  console.log(`[${TAG}] venues ................................ ${total}`);
  console.log(`[${TAG}] with accommodation.roomTypes (marketing) ${withRows}`);
  console.log(`[${TAG}] with rooms[] (operational) ............ ${withRooms}`);
  console.log(`[${TAG}] with roomTypes[] (already adopted) .... ${withTypes}`);
  console.log(`[${TAG}] advertising accommodation ............. ${advertising}`);
  console.log(`[${TAG}]`);
  const bothStructures = await Venue.countDocuments({
    "accommodation.roomTypes.0": { $exists: true }, "rooms.0": { $exists: true },
  });
  console.log(`[${TAG}] holding BOTH structures ............... ${bothStructures}${bothStructures ? "  ← need a hand-mapped decision" : ""}`);
  console.log(`[${TAG}] advertising with no rows .............. ${advertising - withRows >= 0 ? advertising - withRows : 0}  (nothing to migrate; the listing shows the toggle only)\n`);

  const candidates = await Venue.find({ "accommodation.roomTypes.0": { $exists: true } });
  let migrated = 0, skipped = 0, refused = 0;

  for (const venue of candidates) {
    const before = listingView(venue.accommodation);
    const label = `${venue.slug}`;

    if ((venue.roomTypes || []).length) {
      console.log(`[${TAG}] · ${label} — already adopted (${venue.roomTypes.length} types), skipping`);
      skipped += 1;
      continue;
    }
    if ((venue.rooms || []).length) {
      console.log(`[${TAG}] ⚠ ${label} — has ${venue.rooms.length} operational rooms AND marketing rows.`);
      console.log(`[${TAG}]     Mapping existing rooms to types is a judgement call, not a script's. Skipping.`);
      skipped += 1;
      continue;
    }

    const plan = planVenue(venue);
    projectAccommodation(venue);
    const after = listingView(venue.accommodation);
    const drift = diffListing(before, after);

    if (drift.length) {
      console.log(`[${TAG}] ✗ ${label} — REFUSED: the listing would change`);
      drift.forEach((d) => console.log(`[${TAG}]     ${d}`));
      refused += 1;
      continue;
    }

    console.log(`[${TAG}] ✓ ${label} — ${plan.join(", ")}  → ${venue.rooms.length} rooms, ${venue.roomTypes.length} types, listing identical`);
    if (APPLY) {
      await venue.save();
    }
    migrated += 1;
  }

  console.log(`\n[${TAG}] ${migrated} venue(s) ${APPLY ? "migrated" : "would migrate"}, ${skipped} skipped, ${refused} refused.`);
  if (!APPLY) console.log(`[${TAG}] DRY-RUN — nothing written. Re-run with --apply.`);
  if (refused) process.exitCode = 1;
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error(`[${TAG}] FAILED: ${err.message}`);
  try { await mongoose.disconnect(); } catch (e) { /* already down */ }
  process.exitCode = 1;
});
