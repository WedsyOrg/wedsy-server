/**
 * scripts/resource-coverphotos-s3.js
 *
 * THE REAL FIX for rotting venue covers: re-source a current photo from Google
 * Places and store the IMAGE BYTES in Wedsy's own S3, so the cover is owned by
 * us and can never expire again.
 *
 * Why this exists: Google's resolved lh3.googleusercontent.com place-photo URLs
 * carry tokens that expire and start returning 403. ~57 venues are already dead
 * with NO durable alternative anywhere in their documents — photos.* is empty
 * and googlePhotos is 100% lh3, all rotting. Repointing between Google URLs only
 * buys time; the only durable answer is to hold the bytes ourselves.
 *
 * Per venue (--apply):
 *   1. findplacefromtext on "<name> <city>" → place_id.
 *   2. Place details → photos[], preferring the widest available.
 *   3. GET the photo endpoint (maxwidth=1600), follow the 302, download bytes.
 *   4. Upload to S3 via the app's own utils/s3Upload.js — same client, same
 *      bucket, same URL shape as /file/upload. No new AWS config is invented.
 *   5. Live-check the resulting S3 URL returns 200 + image/* BEFORE committing.
 *      Only then $set coverPhoto, and $addToSet the URL into photos.venue[] so
 *      the venue finally has a durable record that later repairs can fall back
 *      to.
 *   6. ANY failure at any step → the venue is left completely unchanged and
 *      logged with a reason. Failures are never partially applied: nothing is
 *      written unless the uploaded object has been verified to serve.
 *
 * SCOPE: writes `coverPhoto` and appends to `photos.venue[]`. Nothing else on
 * any document is touched, and only venues in the target set are considered.
 *
 * SAFETY:
 *   - Dry-run by default. Dry-run live-checks covers to compute the target set
 *     but makes NO Places calls, NO S3 writes and NO database writes.
 *   - Local Mongo always allowed; a REMOTE target requires BOTH ALLOW_REMOTE=1
 *     and --apply. The resolved host is printed before anything else.
 *   - --apply backs up {_id, slug, coverPhoto, photosVenue} for every target and
 *     reads it back before the first write; failure there aborts with nothing
 *     modified. Restore with scripts/restore-coverphotos-from-backup.js.
 *   - Stops if the target set is implausibly large (MAX_TARGETS), which would
 *     mean the live-check — not the catalogue — is what broke.
 *
 * Usage:
 *   node scripts/resource-coverphotos-s3.js                    # dry-run (default)
 *   node scripts/resource-coverphotos-s3.js --limit=3          # sample the target set
 *   PLACES_KEY="$GOOGLE_PLACES_API_KEY" node scripts/resource-coverphotos-s3.js --apply --limit=3
 *   ALLOW_REMOTE=1 PLACES_KEY="$GOOGLE_PLACES_API_KEY" \
 *     node scripts/resource-coverphotos-s3.js --apply          # PROD (both gates)
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const mongoose = require("mongoose");
const Venue = require("../models/Venue");
const { uploadBufferToS3, extensionFor } = require("../utils/s3Upload");

const TAG = "[resource-covers-s3]";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);
const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");
const ALLOW_REMOTE = process.env.ALLOW_REMOTE === "1";
const LIMIT = parseInt((process.argv.find((a) => a.startsWith("--limit=")) || "").split("=")[1] || "0", 10);

// Places key — PLACES_KEY only, no ambient fallback, so a run can never quietly
// pick up credentials the operator did not intend. On the box:
//   PLACES_KEY="$GOOGLE_PLACES_API_KEY" node scripts/resource-coverphotos-s3.js --apply
const PLACES_KEY = process.env.PLACES_KEY || "";

// S3 config is the app's own (utils/s3Upload.js reads these). Listed here only
// so --apply can fail fast with a clear message instead of mid-upload.
const REQUIRED_AWS_ENV = ["AWS_BUCKET_NAME", "AWS_S3_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];

const REQUEST_TIMEOUT_MS = 15000;
const CHECK_TIMEOUT_MS = 3000;
const API_DELAY_MS = 250;
const MAX_REDIRECTS = 5;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const PHOTO_MAXWIDTH = 1600;
// The known-bad population is ~57-73. A target set far above that means the
// live-check is misfiring (e.g. headers stripped), not that the catalogue died.
const MAX_TARGETS = 150;

// Load-bearing, NOT cosmetic: image.wedmegood.com — the largest cover host —
// serves 403 text/html to a bare Node request and 200 image/avif to the same URL
// with a normal User-Agent. Without these headers healthy covers look dead and
// get needlessly re-sourced. Never strip them.
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const redact = (s) => (PLACES_KEY ? String(s).split(PLACES_KEY).join("<redacted>") : String(s));

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (_) {
    return "(unparseable)";
  }
}

function isHttpUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    return /^https?:$/.test(new URL(url).protocol);
  } catch (_) {
    return false;
  }
}

const isLh3 = (url) => isHttpUrl(url) && /googleusercontent\.com$/i.test(new URL(url).hostname);

// ---------------------------------------------------------------------------
// Host gate
// ---------------------------------------------------------------------------
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
  console.log(`${TAG} │ MODE: ${APPLY ? "APPLY" : "DRY-RUN"}  ALLOW_REMOTE=${ALLOW_REMOTE ? "1" : "0"}`);
  console.log(`${TAG} │ PLACES_KEY: ${APPLY ? (PLACES_KEY ? "present" : "NOT SET") : "not needed (dry-run)"}`);
  console.log(`${TAG} │ S3 BUCKET: ${process.env.AWS_BUCKET_NAME || "(unset)"} @ ${process.env.AWS_S3_REGION || "(unset)"}`);
  if (LIMIT) console.log(`${TAG} │ LIMIT: first ${LIMIT} target(s)`);
  console.log(`${TAG} └───────────────────────────────────────────`);
  if (isLocal) return host;
  if (!ALLOW_REMOTE || !APPLY) {
    throw new Error(
      `Refusing to run: DATABASE_URL host "${host}" is REMOTE. ` +
        `The guarded production path requires BOTH ALLOW_REMOTE=1 and --apply ` +
        `(got ALLOW_REMOTE=${ALLOW_REMOTE ? "1" : "0"}, ${APPLY ? "--apply" : "no --apply"}).`
    );
  }
  console.log(`${TAG} ⚠  REMOTE APPLY authorized (ALLOW_REMOTE=1 + --apply) — writing to ${host}`);
  return host;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function rawGet(url, { timeout, headers, collect }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    let req;
    try {
      const mod = new URL(url).protocol === "http:" ? http : https;
      req = mod.get(url, { timeout, headers }, (res) => {
        const { statusCode, headers: h } = res;
        const contentType = h["content-type"] || "";
        const location = h.location || null;
        if (!collect) {
          res.destroy();
          return done({ statusCode, contentType, location });
        }
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size > MAX_IMAGE_BYTES) {
            res.destroy();
            return done({ statusCode, contentType, location, error: `image exceeds ${MAX_IMAGE_BYTES} bytes` });
          }
          chunks.push(c);
        });
        res.on("end", () => done({ statusCode, contentType, location, body: Buffer.concat(chunks) }));
        res.on("error", (e) => done({ statusCode: 0, error: e.message }));
      });
    } catch (e) {
      return done({ statusCode: 0, error: e.message });
    }
    req.on("timeout", () => {
      req.destroy();
      done({ statusCode: 0, error: `timeout after ${timeout}ms` });
    });
    req.on("error", (err) => done({ statusCode: 0, error: err.message }));
  });
}

/** Live-check: does this URL serve an image right now? Memoised per URL. */
const liveCache = new Map();
async function isLive(url) {
  if (!isHttpUrl(url)) return { ok: false, detail: "not an http(s) url" };
  if (liveCache.has(url)) return liveCache.get(url);

  let current = url;
  let result = { ok: false, detail: "unknown" };
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await rawGet(current, { timeout: CHECK_TIMEOUT_MS, headers: BROWSER_HEADERS, collect: false });
    if (res.error) {
      result = { ok: false, detail: res.error };
      break;
    }
    if (res.statusCode >= 300 && res.statusCode < 400 && res.location) {
      try {
        current = new URL(res.location, current).toString();
        continue;
      } catch (e) {
        result = { ok: false, detail: `bad redirect: ${e.message}` };
        break;
      }
    }
    if (res.statusCode === 200) {
      result = /^image\//i.test(res.contentType)
        ? { ok: true, detail: res.contentType.split(";")[0] }
        : { ok: false, detail: `200 but content-type "${res.contentType || "none"}"` };
      break;
    }
    result = { ok: false, detail: `HTTP ${res.statusCode}` };
    break;
  }
  if (result.detail === "unknown") result = { ok: false, detail: `exceeded ${MAX_REDIRECTS} redirects` };
  liveCache.set(url, result);
  return result;
}

async function getJson(url) {
  const res = await rawGet(url, { timeout: REQUEST_TIMEOUT_MS, headers: BROWSER_HEADERS, collect: true });
  if (res.error) throw new Error(res.error);
  if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
  try {
    return JSON.parse(res.body.toString("utf8"));
  } catch (e) {
    throw new Error(`unparseable JSON: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Google Places
// ---------------------------------------------------------------------------

async function findPlaceId(venue) {
  const city = (venue.city || "Bangalore").trim();
  const input = `${venue.name} ${city}`.trim();
  const url =
    `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(input)}` +
    `&inputtype=textquery&fields=place_id&key=${PLACES_KEY}`;
  const data = await getJson(url);
  if (data.status === "OK" && Array.isArray(data.candidates) && data.candidates[0]?.place_id) {
    return data.candidates[0].place_id;
  }
  throw new Error(`findplacefromtext: ${data.status}${data.error_message ? ` — ${data.error_message}` : ""}`);
}

/** Widest photo_reference for a place — cover images want the largest source. */
async function findWidestPhotoRef(placeId) {
  const url =
    `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}` +
    `&fields=photos&key=${PLACES_KEY}`;
  const data = await getJson(url);
  if (data.status !== "OK") {
    throw new Error(`details: ${data.status}${data.error_message ? ` — ${data.error_message}` : ""}`);
  }
  const photos = (data.result && data.result.photos) || [];
  if (!photos.length) throw new Error("place has no photos");
  const best = photos.reduce((a, b) => ((b.width || 0) > (a.width || 0) ? b : a));
  if (!best.photo_reference) throw new Error("photo entry has no photo_reference");
  return { ref: best.photo_reference, width: best.width || 0 };
}

/** Follow the photo endpoint's 302 and download the actual image bytes. */
async function downloadPhoto(photoRef) {
  let current =
    `https://maps.googleapis.com/maps/api/place/photo?maxwidth=${PHOTO_MAXWIDTH}` +
    `&photo_reference=${encodeURIComponent(photoRef)}&key=${PLACES_KEY}`;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await rawGet(current, { timeout: REQUEST_TIMEOUT_MS, headers: BROWSER_HEADERS, collect: true });
    if (res.error) throw new Error(res.error);
    if (res.statusCode >= 300 && res.statusCode < 400 && res.location) {
      current = new URL(res.location, current).toString();
      continue;
    }
    if (res.statusCode !== 200) throw new Error(`photo endpoint HTTP ${res.statusCode}`);
    if (!/^image\//i.test(res.contentType)) throw new Error(`photo endpoint returned "${res.contentType || "none"}"`);
    if (!res.body || !res.body.length) throw new Error("photo endpoint returned an empty body");
    return { buffer: res.body, contentType: res.contentType.split(";")[0] };
  }
  throw new Error(`exceeded ${MAX_REDIRECTS} redirects`);
}

// ---------------------------------------------------------------------------
// Target selection
// ---------------------------------------------------------------------------

/**
 * A venue is a target when its cover is dead, is an lh3 URL (alive or not —
 * those tokens are actively rotting, so re-sourcing pre-empts the next outage),
 * or is empty on a published listing.
 */
async function classify(v) {
  const cover = v.coverPhoto || "";
  if (!cover) {
    return v.status === "published"
      ? { target: true, reason: "empty cover on a published venue" }
      : { target: false };
  }
  if (!isHttpUrl(cover)) {
    // Deliberately NOT a target. In practice these are `data:` URI placeholders
    // (a 1x1 transparent PNG) on destination records — goa, udaipur, jodhpur,
    // thailand, jim-corbett — which are not Bangalore venues at all. They are
    // not rot, and re-sourcing them would be actively harmful: a Places lookup
    // for "goa Bangalore" matches some unrelated business and would stamp a
    // wrong photo onto a destination page. Surfaced in the report instead.
    return { target: false, skipped: "non-http cover (data: URI / placeholder)" };
  }

  const live = await isLive(cover);
  if (!live.ok) return { target: true, reason: `dead: ${live.detail}` };
  if (isLh3(cover)) return { target: true, reason: "lh3 cover still live but rotting" };
  return { target: false };
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------
function writeBackup(targets) {
  const dir = path.join(__dirname, "backups");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // "coverphoto-repair-" prefix so restore-coverphotos-from-backup.js finds it.
  const file = path.join(dir, `coverphoto-repair-s3-resource-${stamp}.json`);
  fs.mkdirSync(dir, { recursive: true });
  const payload = targets.map((t) => ({
    _id: String(t.v._id),
    slug: t.v.slug || "",
    coverPhoto: t.v.coverPhoto || "",
    // photos.venue[] is appended to, so capture it for an exact rollback.
    photosVenue: Array.isArray(t.v.photos && t.v.photos.venue) ? t.v.photos.venue : [],
  }));
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
  const readback = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(readback) || readback.length !== targets.length) {
    throw new Error(`backup readback mismatch: wrote ${targets.length}, read ${readback.length}`);
  }
  return file;
}

// ---------------------------------------------------------------------------

/**
 * Validate --apply prerequisites BEFORE the target-set sweep. That sweep
 * live-checks every venue and takes many minutes; discovering a missing key
 * afterwards would waste the whole run.
 */
function assertApplyPrereqs() {
  if (!APPLY) return;
  if (!PLACES_KEY) {
    throw new Error(
      `Refusing to --apply: PLACES_KEY is not set. There is no ambient fallback by design:\n` +
        `  PLACES_KEY="$GOOGLE_PLACES_API_KEY" node scripts/resource-coverphotos-s3.js --apply`
    );
  }
  const missingAws = REQUIRED_AWS_ENV.filter((k) => !process.env[k]);
  if (missingAws.length) {
    throw new Error(`Refusing to --apply: missing AWS env var(s): ${missingAws.join(", ")}`);
  }
}

async function run() {
  const host = assertMongoTarget();
  assertApplyPrereqs();
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 8000 });
  console.log(`${TAG} connected to Mongo @ ${host}`);

  const venues = await Venue.find({}).select("_id slug name city status coverPhoto photos googlePhotos").sort({ _id: 1 }).lean();
  console.log(`${TAG} live-checking ${venues.length} venue(s) to build the target set…\n`);

  const targets = [];
  const skipped = [];
  for (let i = 0; i < venues.length; i++) {
    if (i > 0 && i % 50 === 0) console.log(`${TAG} …${i}/${venues.length} classified`);
    const c = await classify(venues[i]);
    if (c.target) targets.push({ v: venues[i], reason: c.reason });
    else if (c.skipped) skipped.push({ v: venues[i], reason: c.skipped });
  }

  console.log(`\n${TAG} ───────── TARGET SET (${targets.length}) ─────────`);
  const byReason = {};
  targets.forEach((t) => {
    const bucket = t.reason.startsWith("dead") ? "dead cover" : t.reason;
    byReason[bucket] = (byReason[bucket] || 0) + 1;
  });
  targets.forEach((t, i) => {
    console.log(
      `${TAG} ${String(i + 1).padStart(3)}. ${t.v.slug || t.v._id}  [${t.v.status}]\n` +
        `${TAG}       ${t.v.coverPhoto ? hostOf(t.v.coverPhoto) : "(empty)"} — ${t.reason}`
    );
  });
  if (skipped.length) {
    console.log(`\n${TAG} --- deliberately NOT targeted (${skipped.length}) ---`);
    skipped.forEach((s) => console.log(`${TAG}   ${s.v.slug || s.v._id} [${s.v.status}] — ${s.reason}`));
  }

  console.log(`\n${TAG} target reasons:`, JSON.stringify(byReason));
  console.log(`${TAG} venues checked: ${venues.length} | targets: ${targets.length} | untouched: ${venues.length - targets.length}`);

  if (targets.length > MAX_TARGETS && !FORCE) {
    throw new Error(
      `Refusing to continue: ${targets.length} targets exceeds the ${MAX_TARGETS} ceiling. ` +
        `The known-bad population is ~57-73, so this usually means the live-check is misfiring ` +
        `(browser headers stripped? network fault?) rather than the catalogue having died. ` +
        `Re-run and confirm before overriding with --force.`
    );
  }

  const selected = LIMIT ? targets.slice(0, LIMIT) : targets;

  if (!APPLY) {
    console.log(`\n${TAG} DRY-RUN — no Places calls, no S3 uploads, no documents written.`);
    console.log(`${TAG} An --apply run would attempt to re-source ${selected.length} venue(s).`);
    console.log(`${TAG} Re-run with PLACES_KEY="$GOOGLE_PLACES_API_KEY" --apply to re-source.`);
    await mongoose.disconnect();
    console.log(`${TAG} DONE`);
    return;
  }

  // ---- APPLY ---- (PLACES_KEY / AWS env already validated up front)
  if (!selected.length) {
    console.log(`${TAG} nothing to do.`);
    await mongoose.disconnect();
    console.log(`${TAG} DONE`);
    return;
  }

  let backupFile;
  try {
    backupFile = writeBackup(selected);
  } catch (e) {
    throw new Error(`Refusing to --apply: backup write failed (${e.message}). No documents were modified.`);
  }
  console.log(`\n${TAG} backup of ${selected.length} doc(s) written to ${backupFile}`);

  const failures = [];
  let resourced = 0;

  for (let i = 0; i < selected.length; i++) {
    const { v } = selected[i];
    const label = `${String(i + 1).padStart(3)}/${selected.length} ${v.slug || v._id}`;
    try {
      const placeId = await findPlaceId(v);
      await sleep(API_DELAY_MS);

      const { ref, width } = await findWidestPhotoRef(placeId);
      await sleep(API_DELAY_MS);

      const { buffer, contentType } = await downloadPhoto(ref);
      await sleep(API_DELAY_MS);

      // Deterministic, content-addressed key: re-running with an unchanged
      // upstream photo overwrites the same object instead of littering the bucket.
      const digest = crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16);
      const key = `venues/${v._id}/cover-${digest}.${extensionFor(contentType)}`;
      const s3Url = await uploadBufferToS3({ buffer, key, contentType });

      // Commit ONLY after the uploaded object is verified to actually serve.
      const verify = await isLive(s3Url);
      if (!verify.ok) throw new Error(`uploaded object did not verify: ${verify.detail}`);

      await Venue.updateOne(
        { _id: v._id },
        { $set: { coverPhoto: s3Url }, $addToSet: { "photos.venue": s3Url } }
      );
      resourced++;
      console.log(`${TAG} ${label} OK → S3 (${(buffer.length / 1024).toFixed(0)}kB, src w${width}) ${key}`);
    } catch (e) {
      const reason = redact(e.message);
      failures.push({ _id: String(v._id), slug: v.slug || "", reason });
      console.log(`${TAG} ${label} FAILED (${reason}) — left unchanged`);
    }
    await sleep(API_DELAY_MS);
  }

  console.log(`\n${TAG} ───────────── SUMMARY ─────────────`);
  console.log(`${TAG} targets attempted: ${selected.length}`);
  console.log(`${TAG} re-sourced to S3:  ${resourced}`);
  console.log(`${TAG} failed (unchanged): ${failures.length}`);
  if (failures.length) {
    console.log(`${TAG} --- failures (safe to re-run) ---`);
    failures.forEach((f) => console.log(`${TAG}   ${f.slug || f._id} :: ${f.reason}`));
  }
  console.log(`${TAG} backup: ${backupFile}`);
  console.log(
    `${TAG} rollback: node scripts/restore-coverphotos-from-backup.js --apply --file=${path.basename(backupFile)}`
  );

  await mongoose.disconnect();
  console.log(`${TAG} DONE`);
}

run().catch(async (err) => {
  console.error(`${TAG} FAILED: ${redact(err.message)}`);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
