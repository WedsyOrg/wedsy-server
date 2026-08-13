#!/usr/bin/env node
/**
 * scripts/backup-to-s3.js — nightly production database backup.
 *
 *   mongodump → gzip archive → S3, then prune the local copies.
 *
 * Run from cron on the box. Reuses the app's existing @aws-sdk/client-s3 and
 * the AWS_* / DATABASE_URL values already in .env — no new bucket, no new
 * credentials, no new dependency.
 *
 * CREDENTIAL HANDLING — the connection string carries the database password,
 * so it is passed to mongodump through execFileSync's ARGV ARRAY. There is no
 * shell in that path: nothing is word-split, nothing is interpolated, and
 * nothing lands in shell history. (Caveat worth knowing: argv is still
 * readable via `ps` for the seconds mongodump runs. Closing that too means
 * moving the password into a `mongodump --config` file with 0600 perms; not
 * done here because it changes how the box is provisioned.)
 *
 * THE SANITY GATE is the point of this script as much as the upload is. A
 * mongodump that dies halfway still leaves a well-formed, small .gz behind. If
 * that got uploaded on schedule, the backup listing would look healthy right
 * up until the restore that needed it. So an archive below MIN_ARCHIVE_BYTES
 * is treated as a failed run: it is deleted, nothing is uploaded, and the
 * process exits non-zero so cron mails it.
 *
 * Usage:
 *   node scripts/backup-to-s3.js
 */
require("dotenv").config();

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const BACKUP_DIR = path.join(os.homedir(), "backups");
const S3_PREFIX = "db-backups";
// Calibration note: gzipped BSON is much smaller than the on-disk figure
// (indexes and preallocation don't travel). A 3 MB local database archives to
// ~17 KB, while an almost-empty one archives to ~350 B. So the floor separates
// "truncated" from "healthy" only if it sits below the real production
// archive — check the first run's logged size and raise this if prod dwarfs it.
const MIN_ARCHIVE_BYTES = 100 * 1024;
const PRUNE_AFTER_DAYS = 3;
const PRUNE_AFTER_MS = PRUNE_AFTER_DAYS * 24 * 60 * 60 * 1000;

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
const logErr = (msg) => console.error(`[${new Date().toISOString()}] ${msg}`);

// Filesystem- and S3-safe timestamp: 2026-08-13T02-30-00-000Z.
const stampFor = (d) => d.toISOString().replace(/[:.]/g, "-");

const humanBytes = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

/** Fail fast and by name, so a misconfigured box says which var is missing. */
function requireEnv(names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    throw new Error(`Missing required env var(s): ${missing.join(", ")}`);
  }
}

/**
 * mongodump into `archivePath`. The URI goes through the argv array, never a
 * shell string — see the credential note at the top of this file.
 */
function dumpDatabase(uri, archivePath) {
  try {
    execFileSync(
      "mongodump",
      [`--uri=${uri}`, `--archive=${archivePath}`, "--gzip", "--quiet"],
      // stderr inherited so a mongodump failure reason reaches the cron log;
      // stdin closed because this never runs interactively.
      { stdio: ["ignore", "ignore", "inherit"] }
    );
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error("mongodump not found on PATH — install the MongoDB Database Tools");
    }
    throw new Error(`mongodump failed (exit ${err.status ?? "unknown"})`);
  }
}

/**
 * The gate. Returns the archive size on success; on a short archive it deletes
 * the file and throws, because a truncated dump left lying in the backup
 * directory is worse than no file at all — it reads as a backup.
 */
function assertArchiveIsPlausible(archivePath) {
  if (!fs.existsSync(archivePath)) {
    throw new Error(`mongodump produced no archive at ${archivePath}`);
  }
  const { size } = fs.statSync(archivePath);
  if (size < MIN_ARCHIVE_BYTES) {
    fs.unlinkSync(archivePath);
    throw new Error(
      `Archive is only ${humanBytes(size)} (floor ${humanBytes(MIN_ARCHIVE_BYTES)}) — ` +
        `treating as a truncated dump. Nothing uploaded; the short archive has been deleted.`
    );
  }
  return size;
}

/** Stream the archive to s3://<bucket>/db-backups/<name>. */
async function uploadArchive(s3, { archivePath, key, size }) {
  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: key,
      // Streamed, not buffered — the archive can be far larger than we want to
      // hold in memory. ContentLength is required for a stream body.
      Body: fs.createReadStream(archivePath),
      ContentLength: size,
      ContentType: "application/gzip",
    })
  );
}

/**
 * Drop local archives older than PRUNE_AFTER_DAYS. S3 keeps the long tail;
 * the box only needs enough to restore from without a network round trip.
 * Best-effort per file: one unlink error must not fail an otherwise good run.
 */
function pruneLocalArchives(dir, now = Date.now()) {
  if (!fs.existsSync(dir)) return { removed: 0, kept: 0 };
  let removed = 0;
  let kept = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".gz")) continue;
    const full = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (now - stat.mtimeMs > PRUNE_AFTER_MS) {
      try {
        fs.unlinkSync(full);
        removed++;
        log(`  pruned ${name} (${humanBytes(stat.size)}, ${Math.floor((now - stat.mtimeMs) / 86400000)}d old)`);
      } catch (err) {
        logErr(`  could not prune ${name}: ${err.message}`);
        kept++;
      }
    } else {
      kept++;
    }
  }
  return { removed, kept };
}

async function main() {
  const startedAt = Date.now();
  log("nightly backup: start");

  requireEnv([
    "DATABASE_URL",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_BUCKET_NAME",
    "AWS_S3_REGION",
  ]);

  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const stamp = stampFor(new Date());
  const filename = `wedsy-db-${stamp}.gz`;
  const archivePath = path.join(BACKUP_DIR, filename);
  const key = `${S3_PREFIX}/${filename}`;

  log(`dumping database → ${archivePath}`);
  dumpDatabase(process.env.DATABASE_URL, archivePath);

  const size = assertArchiveIsPlausible(archivePath);
  log(`archive ok: ${humanBytes(size)}`);

  log(`uploading → s3://${process.env.AWS_BUCKET_NAME}/${key}`);
  const s3 = new S3Client({
    region: process.env.AWS_S3_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
  await uploadArchive(s3, { archivePath, key, size });
  log("upload complete");

  log(`pruning local archives older than ${PRUNE_AFTER_DAYS} days in ${BACKUP_DIR}`);
  const { removed, kept } = pruneLocalArchives(BACKUP_DIR);
  log(`prune done: ${removed} removed, ${kept} kept`);

  log(`nightly backup: done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

if (require.main === module) {
  main().catch((err) => {
    logErr(`nightly backup: FAILED — ${err.message}`);
    if (err.stack) logErr(err.stack);
    // Non-zero so cron mails the run and any log-based monitor sees it.
    process.exit(1);
  });
}

module.exports = {
  main,
  dumpDatabase,
  assertArchiveIsPlausible,
  uploadArchive,
  pruneLocalArchives,
  stampFor,
  BACKUP_DIR,
  MIN_ARCHIVE_BYTES,
  PRUNE_AFTER_DAYS,
};
