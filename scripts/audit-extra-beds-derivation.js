/* eslint-disable no-console */
/**
 * scripts/audit-extra-beds-derivation.js — WHAT THE RECOVERY-ON-READ WILL SAY.
 *
 * ROOMS 10 stopped storing a typed maximum. `maxOccupancy` is no longer
 * written; where an existing type carries one ABOVE its base, the extra beds it
 * implies are recovered on READ as (max − base). Nothing is migrated and
 * nothing is written back.
 *
 * That derivation runs over live production data with no migration and no audit
 * trail, so this counts what it will actually produce BEFORE it ships — so the
 * numbers in the PR can be checked later against what was really there.
 *
 * ── READ ONLY ───────────────────────────────────────────────────────────────
 * Opens the connection, reads `roomTypes` off every venue, prints, disconnects.
 * There is no update, no save, no bulk op, and no model import that could run a
 * hook. Uses the driver directly rather than mongoose models for that reason.
 *
 * Usage:
 *   AUDIT_URI="mongodb+srv://..." node scripts/audit-extra-beds-derivation.js
 *
 * The URI is passed at invocation and never read from .env, so this cannot
 * point at production by accident.
 */
// mongoose only for its bundled driver — NO model is imported, so no schema,
// no middleware and no save hook is ever loaded into this process. The read
// goes through the raw collection handle.
const mongoose = require("mongoose");

const URI = process.env.AUDIT_URI;
if (!URI) {
  console.error("AUDIT_URI is required. Pass the connection string at invocation.");
  process.exit(1);
}

/**
 * The SAME arithmetic utils/venueRoomTypes.occupancyOf applies, reproduced here
 * deliberately rather than imported: importing would pull in the model layer,
 * and this script's whole claim is that it touches nothing that can write.
 * If the two ever disagree, that is a finding in itself.
 */
const num = (v, fb = 0) => (Number.isFinite(Number(v)) ? Number(v) : fb);
const baseOf = (t) => Math.max(1, num(t.bedsSleep, num(t.sleeps, 2)));

(async () => {
  try {
    await mongoose.connect(URI, { serverSelectionTimeoutMS: 15000 });
    const venues = await mongoose.connection.db
      .collection("venues")
      .find({ "roomTypes.0": { $exists: true } }, { projection: { name: 1, slug: 1, roomTypes: 1 } })
      .toArray();

    let types = 0;
    const above = [];
    const atOrBelow = [];
    const absent = [];
    const alreadyNew = [];

    for (const v of venues) {
      for (const t of v.roomTypes || []) {
        types += 1;
        const base = baseOf(t);
        const row = {
          venue: v.slug || v.name,
          type: t.name,
          base,
          storedMax: t.maxOccupancy,
          storedSleeps: t.sleeps,
          storedBedsSleep: t.bedsSleep,
        };
        if (t.extraBedsPossible !== undefined && t.extraBedsPossible !== null) {
          alreadyNew.push({ ...row, extraBedsPossible: t.extraBedsPossible });
          continue;
        }
        const max = num(t.maxOccupancy, 0);
        if (!max) absent.push(row);
        else if (max > base) above.push({ ...row, wouldImply: max - base, wouldRead: `${base} + ${max - base} = ${max}` });
        else atOrBelow.push({ ...row, wouldImply: "UNSTATED", wouldRead: `${base} (ceiling stays unstated)` });
      }
    }

    console.log("");
    console.log("══ EXTRA-BED DERIVATION AUDIT (read-only) ══════════════════════");
    console.log(`venues with at least one room type : ${venues.length}`);
    console.log(`room types total                   : ${types}`);
    console.log("");
    console.log(`maxOccupancy ABOVE base            : ${above.length}   → recovered as (max − base)`);
    console.log(`maxOccupancy AT OR BELOW base      : ${atOrBelow.length}   → implies nothing, stays UNSTATED`);
    console.log(`maxOccupancy absent or 0           : ${absent.length}   → implies nothing, stays UNSTATED`);
    console.log(`already on extraBedsPossible       : ${alreadyNew.length}   → untouched by the derivation`);
    console.log("");

    if (above.length) {
      console.log("── EVERY TYPE THE DERIVATION CHANGES THE READING OF ────────────");
      for (const r of above) {
        console.log(`  ${String(r.venue).padEnd(28)} ${String(r.type).padEnd(24)} base ${r.base}, stored max ${r.storedMax} → extraBedsPossible ${r.wouldImply}  (reads "${r.wouldRead}")`);
      }
      console.log("");
    }

    if (atOrBelow.length) {
      console.log("── TYPES WHOSE STORED MAX CONTRADICTED THEIR BASE ──────────────");
      console.log("   (a maximum at or below the base — the arithmetic that could not be true)");
      for (const r of atOrBelow) {
        console.log(`  ${String(r.venue).padEnd(28)} ${String(r.type).padEnd(24)} base ${r.base}, stored max ${r.storedMax} → ${r.wouldImply}`);
      }
      console.log("");
    }

    console.log("Nothing was written. This script has no update path.");
  } catch (err) {
    console.error("FAILED:", err.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
