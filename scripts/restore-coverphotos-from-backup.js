/**
 * scripts/restore-coverphotos-from-backup.js
 *
 * Rollback for scripts/repair-places-coverphotos.js. Restores Venue.coverPhoto
 * to the exact values captured in a repair run's backup dump.
 *
 * Writes through the NATIVE driver (Venue.collection) rather than the Mongoose
 * model — deliberately. The backup holds raw keyed Places URLs, which the
 * coverPhoto guard in models/Venue.js correctly refuses to persist. A rollback
 * must be able to put the pre-repair state back verbatim, guard or not, so it
 * bypasses model middleware. Nothing else in the codebase should do this.
 *
 * SCOPE: sets `coverPhoto` and nothing else, only on _ids named in the backup.
 *
 * SAFETY: same gate as the repair script — local always allowed; a remote target
 * requires BOTH ALLOW_REMOTE=1 and --apply. Dry-run is the default.
 *
 * Usage:
 *   node scripts/restore-coverphotos-from-backup.js                      # dry-run, newest backup
 *   node scripts/restore-coverphotos-from-backup.js --apply
 *   node scripts/restore-coverphotos-from-backup.js --file=<name.json> --apply
 *   ALLOW_REMOTE=1 node scripts/restore-coverphotos-from-backup.js --apply   # PROD rollback
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const Venue = require("../models/Venue");
const TAG = "[restore-coverphotos]";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);
const APPLY = process.argv.includes("--apply");
const ALLOW_REMOTE = process.env.ALLOW_REMOTE === "1";
const FILE_ARG = (process.argv.find((a) => a.startsWith("--file=")) || "").split("=")[1] || "";
function assertMongoTarget() {
  const url = process.env.DATABASE_URL || "";
  let host;
  try {
    host = new URL(url).hostname;
  } catch (e) {
    throw new Error(`Cannot parse DATABASE_URL to verify host: ${e.message}`);
  }
  const isLocal = LOCAL_HOSTS.has(host);
  console.log(`${TAG} ┌───────────────────────────────────────────`);
  console.log(`${TAG} │ TARGET HOST: ${host}  (${isLocal ? "local" : "REMOTE"})`);
  console.log(`${TAG} │ MODE: ${APPLY ? "APPLY (rollback)" : "DRY-RUN"}  ALLOW_REMOTE=${ALLOW_REMOTE ? "1" : "0"}`);
  console.log(`${TAG} └───────────────────────────────────────────`);
  if (isLocal) return host;
  if (!ALLOW_REMOTE || !APPLY) {
    throw new Error(
      `Refusing to run: DATABASE_URL host "${host}" is REMOTE. ` +
        `Rollback against a remote target requires BOTH ALLOW_REMOTE=1 and --apply.`
    );
  }
  console.log(`${TAG} ⚠  REMOTE ROLLBACK authorized — writing to ${host}`);
  return host;
}
function loadBackup() {
  const dir = path.join(__dirname, "backups");
  if (!fs.existsSync(dir)) throw new Error(`No backups directory at ${dir}`);
  const candidates = fs.readdirSync(dir).filter((f) => f.startsWith("coverphoto-repair-") && f.endsWith(".json")).sort();
  if (!candidates.length) throw new Error(`No coverphoto-repair-*.json backups in ${dir}`);
  const name = FILE_ARG || candidates[candidates.length - 1];
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) throw new Error(`Backup not found: ${file}`);
  const rows = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(rows) || !rows.length) throw new Error(`Backup ${name} is empty or malformed`);
  for (const r of rows) {
    if (!r._id || typeof r.coverPhoto !== "string") throw new Error(`Backup ${name} has a malformed row`);
    if (r.photosVenue !== undefined && !Array.isArray(r.photosVenue)) {
      throw new Error(`Backup ${name} has a malformed photosVenue on ${r.slug || r._id}`);
    }
  }
  const withPhotos = rows.filter((r) => Array.isArray(r.photosVenue)).length;
  if (withPhotos) {
    console.log(`${TAG} ${withPhotos} row(s) also carry photos.venue[] — that field will be restored too.`);
  }
  console.log(`${TAG} backup: ${name} (${rows.length} doc(s))${FILE_ARG ? "" : "  [newest]"}`);
  if (candidates.length > 1 && !FILE_ARG) {
    console.log(`${TAG} note: ${candidates.length} backups present — pass --file=<name> to pick another.`);
  }
  return rows;
}
async function run() {
  const host = assertMongoTarget();
  const rows = loadBackup();
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 8000 });
  console.log(`${TAG} connected to Mongo @ ${host}`);
  const sameArray = (a, b) =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
  let differs = 0;
  for (const r of rows) {
    const cur = await Venue.findById(r._id).select("coverPhoto photos.venue").lean();
    if (!cur) {
      console.log(`${TAG} MISSING _id=${r._id} (${r.slug}) — skipped`);
      continue;
    }
    const coverDiffers = cur.coverPhoto !== r.coverPhoto;
    const photosDiffer =
      Array.isArray(r.photosVenue) && !sameArray(cur.photos && cur.photos.venue, r.photosVenue);
    if (coverDiffers || photosDiffer) differs++;
  }
  console.log(`${TAG} ${differs}/${rows.length} doc(s) currently differ from the backup`);
  if (!APPLY) {
    console.log(`${TAG} DRY-RUN — nothing written. Re-run with --apply to roll back.`);
    await mongoose.disconnect();
    console.log(`${TAG} DONE`);
    return;
  }
  let restored = 0;
  for (const r of rows) {
    // Native driver: bypasses the coverPhoto guard so pre-repair values (which
    // are exactly what the guard rejects) can be written back verbatim.
    const $set = { coverPhoto: r.coverPhoto };
    // Only restore photos.venue[] when the backup captured it — older dumps
    // (coverPhoto-only repairs) never touched that field, so writing it would
    // clobber edits the repair was never responsible for.
    if (Array.isArray(r.photosVenue)) $set["photos.venue"] = r.photosVenue;
    const res = await Venue.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(r._id)) },
      { $set }
    );
    if (res.matchedCount) restored++;
  }
  let mismatched = 0;
  for (const r of rows) {
    const cur = await Venue.findById(r._id).select("coverPhoto photos.venue").lean();
    if (!cur || cur.coverPhoto !== r.coverPhoto) {
      mismatched++;
    } else if (Array.isArray(r.photosVenue) && !sameArray(cur.photos && cur.photos.venue, r.photosVenue)) {
      mismatched++;
    }
  }
  console.log(`${TAG} ───────────── SUMMARY ─────────────`);
  console.log(`${TAG} rows in backup:  ${rows.length}`);
  console.log(`${TAG} docs restored:   ${restored}`);
  console.log(`${TAG} still mismatched after restore: ${mismatched}`);
  console.log(
    mismatched === 0
      ? `${TAG} ✅ every doc is byte-identical to the backup.`
      : `${TAG} ⚠  ${mismatched} doc(s) did not match after restore — investigate.`
  );
  await mongoose.disconnect();
  console.log(`${TAG} DONE`);
}
run().catch(async (err) => {
  console.error(`${TAG} FAILED: ${err.message}`);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});