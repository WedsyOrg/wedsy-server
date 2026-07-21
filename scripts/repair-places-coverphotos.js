/**
 * scripts/repair-places-coverphotos.js
 *
 * Repair Venue.coverPhoto values that were persisted as RAW Google Places Photo
 * endpoint URLs with an embedded API key:
 *
 *   https://maps.googleapis.com/maps/api/place/photo?maxwidth=800&photo_reference=...&key=<DEAD_KEY>
 *
 * That key has since been revoked, so every one of those covers now renders
 * broken. The Places Photo endpoint is a *redirector* — it 302s to a durable,
 * keyless lh3.googleusercontent.com URL. The fix is to re-issue the request with
 * a LIVE key, follow the redirect, and store the final lh3 URL instead — which
 * is exactly the shape the venues with working covers already have.
 *
 * TWO-TIER REPAIR:
 *   PLAN A (preferred) — re-resolve the stored photo_reference with a live key
 *     and persist the durable URL it redirects to. Preserves the exact photo the
 *     importer originally chose, at its original width.
 *   PLAN B (fallback)  — if Plan A fails for a doc (photo_reference rotated,
 *     non-200, no redirect, or the chain never leaves maps.googleapis.com), fall
 *     back to that venue's own googlePhotos[0], but ONLY if it is itself durable
 *     and keyless. Every affected venue was Places-enriched and already carries
 *     up to 10 resolved lh3 URLs, so this is a same-place photo from the same
 *     source — a slightly different frame, not a wrong image.
 *   Only when BOTH fail is the doc left untouched and logged.
 *
 * SCOPE: this script only ever writes the `coverPhoto` field, and only on docs
 * matched by the narrow filter below. No other field on any doc is touched.
 *
 * SAFETY:
 *   - Refuses to run against a non-local Mongo UNLESS the operator deliberately
 *     opts in with BOTH `ALLOW_REMOTE=1` and `--apply` (the guarded production
 *     path — same gate as scripts/migrate-rbac-v2.js). The resolved host is
 *     printed prominently before anything else happens.
 *   - Dry-run is the default: it does not fetch and does not write. It only
 *     lists what WOULD be touched.
 *   - --apply dumps a {_id, slug, coverPhoto} backup of every matched doc to
 *     scripts/backups/ BEFORE the first write, and aborts if that dump fails.
 *   - A blast-radius assertion stops the run if the filter matches implausibly
 *     many docs (see MAX_EXPECTED) — that would mean the filter got too broad.
 *
 * Usage:
 *   node scripts/repair-places-coverphotos.js       # dry-run (default) — no fetch, no write
 *
 *   # local repair — key sourced inline from the existing .env var
 *   PLACES_KEY="$GOOGLE_PLACES_API_KEY" node scripts/repair-places-coverphotos.js --apply
 *
 *   # PROD repair — BOTH gates required
 *   ALLOW_REMOTE=1 PLACES_KEY="$GOOGLE_PLACES_API_KEY" \
 *     node scripts/repair-places-coverphotos.js --apply
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const https = require("https");
const mongoose = require("mongoose");
const Venue = require("../models/Venue");

const TAG = "[repair-coverphotos]";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);
const APPLY = process.argv.includes("--apply");
const ALLOW_REMOTE = process.env.ALLOW_REMOTE === "1";

// Live Places key — read from PLACES_KEY and nothing else. There is deliberately
// NO fallback to GOOGLE_PLACES_API_KEY: the key must be passed explicitly at the
// call site so a repair run can never silently pick up ambient credentials. On
// the box, source it inline from the existing .env var:
//   PLACES_KEY="$GOOGLE_PLACES_API_KEY" node scripts/repair-places-coverphotos.js --apply
// Never hardcoded, never written to a new file, never logged.
const PLACES_KEY = process.env.PLACES_KEY || "";

// The audit found 46 affected venues out of 281. If the filter suddenly matches
// far more than that, the filter — not the data — is what changed, and we stop
// rather than rewrite half the catalogue.
const EXPECTED_APPROX = 46;
const MAX_EXPECTED = 100;

// Politeness delay between Places fetches (ms).
const FETCH_DELAY_MS = 250;
// Max 3xx hops to follow when resolving a photo URL.
const MAX_REDIRECTS = 5;

// ---------------------------------------------------------------------------
// The filter. Deliberately narrow: BOTH conditions must hold — the URL must hit
// the Places Photo endpoint AND carry an embedded key. A durable lh3 URL matches
// neither, a wedmegood/cloudfront URL matches neither.
// ---------------------------------------------------------------------------
const BROKEN_COVER_FILTER = {
  $and: [
    { coverPhoto: { $regex: "maps\\.googleapis\\.com/maps/api/place/photo" } },
    { coverPhoto: { $regex: "key=" } },
  ],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Mask the API key in a URL so it never reaches logs or the console. */
function redactKey(url) {
  return String(url || "").replace(/([?&]key=)[^&]*/gi, "$1<redacted>");
}

/** Shorten a URL for tabular console output, keeping the key redacted. */
function truncate(url, max = 120) {
  const safe = redactKey(url);
  return safe.length > max ? `${safe.slice(0, max)}…` : safe;
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (_) {
    return "(unparseable)";
  }
}

// ---------------------------------------------------------------------------
// Two durability predicates, deliberately different in strictness.
//
// PLAN A accepts on `isKeylessNonMaps`: a well-formed http(s) URL that has left
// maps.googleapis.com and carries no embedded key. It is intentionally NOT
// host-allow-listed — Plan A only ever inspects a URL Google itself just
// redirected us to, and pinning that to a fixed host list would turn a future
// Google CDN rename into 46 spurious failures.
//
// PLAN B screens on `isDurableUrl`: the same test PLUS a host allow-list. Here
// we are picking a previously-stored value with no live signal that it is any
// good, so it must match a host the live catalogue is known to serve covers
// from — lh3.googleusercontent.com, image(s).wedmegood.com, *.cloudfront.net,
// *.s3.*.amazonaws.com, gcpimages.theweddingcompany.com.
// ---------------------------------------------------------------------------
const DURABLE_HOST_RE = /(^|\.)(googleusercontent\.com|wedmegood\.com|cloudfront\.net|amazonaws\.com|theweddingcompany\.com)$/i;

function isKeylessNonMaps(url) {
  if (!url || typeof url !== "string") return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return false;
  }
  if (!/^https?:$/.test(parsed.protocol)) return false;
  if (parsed.hostname === "maps.googleapis.com") return false;
  if (/[?&]key=/i.test(url)) return false;
  return true;
}

function isDurableUrl(url) {
  if (!isKeylessNonMaps(url)) return false;
  return DURABLE_HOST_RE.test(new URL(url).hostname);
}

/**
 * PLAN B — the venue's own already-resolved Places photos. Returns the first
 * DURABLE entry, or null when none qualifies (in which case the doc is left
 * unchanged and logged).
 *
 * Note: this scans for the first durable entry rather than testing googlePhotos[0]
 * and giving up if that one specific slot fails — otherwise a single junk entry
 * at index 0 would strand a venue that has nine perfectly good photos behind it.
 * On the current data the two are identical (all 459 entries across the 46 docs
 * are lh3), so this only ever matters as a safety margin.
 */
function pickFallbackUrl(doc) {
  const photos = Array.isArray(doc.googlePhotos) ? doc.googlePhotos : [];
  return photos.find((u) => isDurableUrl(u)) || null;
}

// ---------------------------------------------------------------------------
// Host gate — local always allowed; remote needs BOTH ALLOW_REMOTE=1 and --apply.
// Prints the resolved target before any connection or query happens.
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
  console.log(`${TAG} │ PLACES_KEY: ${PLACES_KEY ? "present" : "NOT SET"}`);
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
// Photo resolution
// ---------------------------------------------------------------------------

/** Replace the dead key in a stored Places Photo URL with the live one. */
function withLiveKey(storedUrl) {
  const u = new URL(storedUrl);
  u.searchParams.set("key", PLACES_KEY);
  return u.toString();
}

/**
 * Issue a GET and return the Location header without downloading the body.
 * The Places Photo endpoint answers 302 → googleusercontent.com; we want the
 * URL, not the image bytes, so the response is destroyed as soon as the headers
 * land. Mirrors utils/enrichVenue.js#resolvePhotoUrl.
 */
function headOnlyGet(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 15000 }, (res) => {
      const { statusCode, headers } = res;
      res.destroy(); // never read the body
      resolve({ statusCode, location: headers.location || null });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ statusCode: 0, location: null, error: "timeout" });
    });
    req.on("error", (err) => resolve({ statusCode: 0, location: null, error: err.message }));
  });
}

/**
 * Follow the redirect chain from a keyed Places Photo URL to its final durable
 * URL. Returns { ok, finalUrl, reason }. A result is only `ok` when the chain
 * terminates off maps.googleapis.com and the final URL carries no key — i.e. a
 * durable lh3.googleusercontent.com-style URL that will outlive any key.
 */
async function resolveDurableUrl(storedUrl) {
  let current;
  try {
    current = withLiveKey(storedUrl);
  } catch (e) {
    return { ok: false, reason: `unparseable stored URL: ${e.message}` };
  }

  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    const { statusCode, location, error } = await headOnlyGet(current);
    if (error) return { ok: false, reason: `network error: ${error}` };

    if (statusCode >= 300 && statusCode < 400 && location) {
      current = new URL(location, current).toString();
      // Landed somewhere durable and keyless — done.
      if (isKeylessNonMaps(current)) {
        return { ok: true, finalUrl: current, host: hostOf(current) };
      }
      continue; // still on maps / still keyed — keep following
    }

    if (statusCode === 200) {
      // No redirect issued. Whatever we're holding is either still the keyed
      // maps URL (useless — it dies with the key) or already durable.
      if (isKeylessNonMaps(current)) {
        return { ok: true, finalUrl: current, host: hostOf(current) };
      }
      return { ok: false, reason: `200 with no redirect; still on ${hostOf(current)}` };
    }

    return { ok: false, reason: `HTTP ${statusCode || "no response"}` };
  }
  return { ok: false, reason: `exceeded ${MAX_REDIRECTS} redirects` };
}

// ---------------------------------------------------------------------------
// Backup — must succeed before the first write in --apply mode.
// ---------------------------------------------------------------------------
function writeBackup(docs) {
  const dir = path.join(__dirname, "backups");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `coverphoto-repair-${stamp}.json`);
  fs.mkdirSync(dir, { recursive: true });
  const payload = docs.map((d) => ({
    _id: String(d._id),
    slug: d.slug || "",
    coverPhoto: d.coverPhoto, // stored VERBATIM — this is the rollback source
  }));
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
  // Read it back: a backup we cannot re-read is not a backup.
  const readback = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(readback) || readback.length !== docs.length) {
    throw new Error(`backup readback mismatch: wrote ${docs.length}, read ${readback.length}`);
  }
  return file;
}

// ---------------------------------------------------------------------------

async function run() {
  const host = assertMongoTarget();
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 8000 });
  console.log(`${TAG} connected to Mongo @ ${host}`);

  const totalVenues = await Venue.countDocuments({});
  // googlePhotos is fetched for Plan B's fallback screen; it is read-only here
  // and is never written by this script.
  const docs = await Venue.find(BROKEN_COVER_FILTER).select("_id slug coverPhoto googlePhotos").lean();
  console.log(`${TAG} matched ${docs.length} venue(s) with a keyed Places Photo coverPhoto (of ${totalVenues} total)`);

  // Blast-radius assertion.
  if (docs.length > MAX_EXPECTED) {
    throw new Error(
      `Refusing to continue: filter matched ${docs.length} docs, which exceeds the ` +
        `MAX_EXPECTED ceiling of ${MAX_EXPECTED} (audit expected ~${EXPECTED_APPROX}). ` +
        `That strongly suggests the filter is too broad — investigate before running again.`
    );
  }
  if (docs.length === 0) {
    console.log(`${TAG} nothing to do.`);
    await mongoose.disconnect();
    console.log(`${TAG} DONE`);
    return;
  }
  if (Math.abs(docs.length - EXPECTED_APPROX) > 10) {
    console.log(
      `${TAG} NOTE: matched ${docs.length}, audit expected ~${EXPECTED_APPROX} — within the ` +
        `${MAX_EXPECTED} ceiling so continuing, but worth an eyeball.`
    );
  }

  // ---- DRY-RUN: list only. No fetches, no writes. ----
  if (!APPLY) {
    console.log(`${TAG} --- DRY-RUN: the following ${docs.length} venue(s) WOULD be repaired ---`);
    let planBReady = 0;
    docs.forEach((d, i) => {
      const fallback = pickFallbackUrl(d);
      if (fallback) planBReady++;
      console.log(`${TAG} ${String(i + 1).padStart(3)}. _id=${d._id}  slug=${d.slug || "(none)"}`);
      console.log(`${TAG}       host=${hostOf(d.coverPhoto)}  cover=${truncate(d.coverPhoto)}`);
      console.log(
        `${TAG}       plan-B fallback: ${fallback ? `${hostOf(fallback)} (of ${d.googlePhotos.length} googlePhotos)` : "NONE — would be logged as a failure if A fails"}`
      );
    });
    console.log(`${TAG} --- end of list: ${docs.length} venue(s) ---`);
    console.log(`${TAG} plan-B fallback available for ${planBReady}/${docs.length} venue(s)`);
    console.log(
      `${TAG} → worst case (every plan-A resolve fails): ${planBReady} repaired via B, ` +
        `${docs.length - planBReady} logged as failures.`
    );
    console.log(`${TAG} DRY-RUN — no HTTP requests issued, no documents written.`);
    console.log(`${TAG} Re-run with PLACES_KEY="$GOOGLE_PLACES_API_KEY" --apply to repair.`);
    await mongoose.disconnect();
    console.log(`${TAG} DONE`);
    return;
  }

  // ---- APPLY ----
  if (!PLACES_KEY) {
    throw new Error(
      `Refusing to --apply: PLACES_KEY is not set. There is no fallback to ` +
        `GOOGLE_PLACES_API_KEY by design — pass it explicitly at the call site:\n` +
        `  PLACES_KEY="$GOOGLE_PLACES_API_KEY" node scripts/repair-places-coverphotos.js --apply`
    );
  }

  let backupFile;
  try {
    backupFile = writeBackup(docs);
  } catch (e) {
    throw new Error(`Refusing to --apply: backup write failed (${e.message}). No documents were modified.`);
  }
  console.log(`${TAG} backup of ${docs.length} doc(s) written to ${backupFile}`);

  const failures = [];
  let repairedA = 0; // Plan A — re-resolved via the live Places key
  let repairedB = 0; // Plan B — fell back to the venue's own googlePhotos

  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    const label = `${String(i + 1).padStart(3)}/${docs.length} ${d.slug || d._id}`;

    // ---- PLAN A ----
    const result = await resolveDurableUrl(d.coverPhoto);
    if (result.ok) {
      // ONLY coverPhoto is ever set. Nothing else on the doc is touched.
      await Venue.updateOne({ _id: d._id }, { $set: { coverPhoto: result.finalUrl } });
      repairedA++;
      console.log(`${TAG} ${label} A:OK → ${result.host}`);
      await sleep(FETCH_DELAY_MS);
      continue;
    }

    // ---- PLAN B ----
    const fallback = pickFallbackUrl(d);
    if (fallback) {
      await Venue.updateOne({ _id: d._id }, { $set: { coverPhoto: fallback } });
      repairedB++;
      console.log(
        `${TAG} ${label} A:FAILED (${result.reason}) → B:OK using googlePhotos → ${hostOf(fallback)}`
      );
    } else {
      const nPhotos = Array.isArray(d.googlePhotos) ? d.googlePhotos.length : 0;
      const reason = `A: ${result.reason}; B: no durable googlePhotos entry (${nPhotos} present)`;
      failures.push({ _id: String(d._id), slug: d.slug || "", reason });
      console.log(`${TAG} ${label} A+B FAILED — left unchanged (${reason})`);
    }

    await sleep(FETCH_DELAY_MS);
  }

  // ---- VERIFY ----
  const repaired = repairedA + repairedB;
  const remaining = await Venue.countDocuments(BROKEN_COVER_FILTER);
  console.log(`${TAG} ───────────── SUMMARY ─────────────`);
  console.log(`${TAG} matched:            ${docs.length}`);
  console.log(`${TAG} A (re-resolved):    ${repairedA}`);
  console.log(`${TAG} B (googlePhotos):   ${repairedB}`);
  console.log(`${TAG} failed (A+B):       ${failures.length}`);
  console.log(`${TAG} total repaired:     ${repaired}`);
  console.log(`${TAG} remaining matching the filter: ${remaining} (expected ${docs.length - repaired})`);
  if (remaining !== docs.length - repaired) {
    console.log(`${TAG} ⚠  remaining count does not equal matched-minus-repaired — investigate.`);
  }
  if (failures.length) {
    console.log(`${TAG} --- failures (unchanged, safe to re-run) ---`);
    failures.forEach((f) => console.log(`${TAG}   _id=${f._id} slug=${f.slug || "(none)"} :: ${f.reason}`));
  } else {
    console.log(`${TAG} ✅ all ${docs.length} matched venue(s) now carry a durable coverPhoto.`);
  }
  console.log(`${TAG} backup: ${backupFile}`);

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
