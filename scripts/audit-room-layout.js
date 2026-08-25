/**
 * scripts/audit-room-layout.js
 *
 * ROOMS 3 asks one question of the existing data: what happens to rooms that
 * have no block and no floor, because every room in production is one.
 *
 * ── THERE IS NOTHING TO MIGRATE, AND THAT IS THE FINDING ────────────────────
 * A room with no blockRef at a venue with no blocks is not broken data. It is
 * the whole property, and utils/venueRoomLayout.resolveLayout renders it as one
 * unnamed block holding one unnamed floor holding every room — the same shape a
 * structured venue resolves to, so every screen loops identically.
 *
 * Inventing blocks would be worse than doing nothing: a "Main Block" nobody
 * named is exactly the derived-rather-than-typed value this build refuses
 * elsewhere, and an owner would then have to delete it before organising the
 * property their way.
 *
 * So this script WRITES NOTHING, ever — there is no --apply. It reports what
 * the layout resolves to today, per venue, so the claim above can be checked
 * against real data rather than asserted.
 *
 * Usage:
 *   node scripts/audit-room-layout.js
 *   DATABASE_URL=… node scripts/audit-room-layout.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Venue = require("../models/Venue");
const { resolveLayout } = require("../utils/venueRoomLayout");

const TAG = "audit-room-layout";

async function run() {
  const url = process.env.DATABASE_URL || "";
  let host = "?";
  try { host = new URL(url).hostname; } catch (e) { /* reported as ? */ }
  console.log(`[${TAG}] ┌───────────────────────────────────────────`);
  console.log(`[${TAG}] │ TARGET HOST: ${host}`);
  console.log(`[${TAG}] │ MODE: READ-ONLY — this script has no write path`);
  console.log(`[${TAG}] └───────────────────────────────────────────\n`);

  await mongoose.connect(url, { serverSelectionTimeoutMS: 8000 });

  const total = await Venue.countDocuments({});
  const withRooms = await Venue.find({ "rooms.0": { $exists: true } })
    .select("slug name rooms blocks")
    .lean();
  const withBlocks = await Venue.countDocuments({ "blocks.0": { $exists: true } });
  const placed = await Venue.countDocuments({ "rooms.blockRef": { $ne: null } });

  console.log(`[${TAG}] ══ WHAT THIS DATABASE HOLDS ═══════════════════════════`);
  console.log(`[${TAG}] venues ................................ ${total}`);
  console.log(`[${TAG}] with any rooms ........................ ${withRooms.length}`);
  console.log(`[${TAG}] with blocks defined ................... ${withBlocks}`);
  console.log(`[${TAG}] with at least one PLACED room ......... ${placed}`);
  console.log(`[${TAG}]`);

  let roomsTotal = 0;
  let unplacedTotal = 0;
  for (const v of withRooms) {
    const layout = resolveLayout(v);
    roomsTotal += layout.counts.rooms;
    unplacedTotal += layout.counts.unplaced;
    const shape = layout.blocks
      .map((b) => `${b.isImplicit ? "(whole property)" : b.name}[${b.floors.map((f) => f.rooms.length).join("/")}]`)
      .join(" ");
    console.log(
      `[${TAG}] ${v.slug} — ${layout.counts.rooms} room(s), ` +
        `${layout.counts.blocks} block(s), ${layout.counts.floors} floor(s), ` +
        `${layout.counts.unplaced} unplaced  →  ${shape}`
    );
  }

  console.log(`\n[${TAG}] ══ WHAT IT MEANS FOR DISPLAY ══════════════════════════`);
  console.log(`[${TAG}] rooms in total ........................ ${roomsTotal}`);
  console.log(`[${TAG}] rooms shown as UNPLACED ............... ${unplacedTotal}`);
  if (unplacedTotal === 0) {
    console.log(`[${TAG}] Every room resolves into a layout. Venues with no blocks render`);
    console.log(`[${TAG}] as one unnamed block and one unnamed floor — the owner sees their`);
    console.log(`[${TAG}] rooms exactly as before, with no "unplaced" warning, until they`);
    console.log(`[${TAG}] choose to organise the property.`);
  } else {
    console.log(`[${TAG}] ⚠ ${unplacedTotal} room(s) sit at venues that DO have blocks but`);
    console.log(`[${TAG}]   have not been placed. They appear in a named bucket at the end`);
    console.log(`[${TAG}]   of the layout, not hidden.`);
  }
  console.log(`\n[${TAG}] NOTHING WAS WRITTEN. This script has no --apply.`);
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error(`[${TAG}] FAILED: ${err.message}`);
  try { await mongoose.disconnect(); } catch (e) { /* already down */ }
  process.exitCode = 1;
});
