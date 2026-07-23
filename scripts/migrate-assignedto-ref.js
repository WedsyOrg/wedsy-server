/**
 * scripts/migrate-assignedto-ref.js
 *
 * MB-CRM S0a: reconcile the legacy VenueEnquiry.assignedTo STRING values with
 * the new ObjectId ref to VenueTeamMember. Per-document resolution order:
 *   1. exact _id     — assignedTo is a valid ObjectId of a member in THIS venue
 *   2. exact name    — assignedTo matches a member name in THIS venue (exact)
 *   3. case-insens.  — same, case-insensitive
 *   no match         — set null + log the (venue, value) for manual reassignment.
 * Already-ObjectId and empty values are normalized (empty → null). ADDITIVE and
 * idempotent; writes go through the native collection so no full-doc validation
 * (event-window hook etc.) runs on legacy rows.
 *
 * SAFETY (matches scripts/migrate-rbac-v2.js): refuses a non-local Mongo UNLESS
 * BOTH ALLOW_REMOTE=1 and --apply are set. Local hosts always allowed. Dry-run
 * is the default and writes nothing; --apply backs up first to scripts/backups/.
 *
 * Usage:
 *   node scripts/migrate-assignedto-ref.js                         # local dry-run (default)
 *   node scripts/migrate-assignedto-ref.js --apply                 # local backup + write
 *   ALLOW_REMOTE=1 node scripts/migrate-assignedto-ref.js --apply  # PROD (both gates)
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueTeamMember = require("../models/VenueTeamMember");

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);
const APPLY = process.argv.includes("--apply");
const ALLOW_REMOTE = process.env.ALLOW_REMOTE === "1";
const BACKUP_DIR = path.join(__dirname, "backups");

function assertMongoTarget() {
  const url = process.env.DATABASE_URL || "";
  let host;
  try {
    host = new URL(url).hostname;
  } catch (e) {
    throw new Error(`Cannot parse DATABASE_URL to verify host: ${e.message}`);
  }
  const isLocal = LOCAL_HOSTS.has(host);
  console.log(`[migrate-assignedto-ref] ┌───────────────────────────────────────────`);
  console.log(`[migrate-assignedto-ref] │ TARGET HOST: ${host}  (${isLocal ? "local" : "REMOTE"})`);
  console.log(`[migrate-assignedto-ref] │ MODE: ${APPLY ? "APPLY" : "DRY-RUN"}  ALLOW_REMOTE=${ALLOW_REMOTE ? "1" : "0"}`);
  console.log(`[migrate-assignedto-ref] └───────────────────────────────────────────`);
  if (isLocal) return host;
  if (!ALLOW_REMOTE || !APPLY) {
    throw new Error(
      `Refusing to run: DATABASE_URL host "${host}" is REMOTE. The guarded ` +
        `production path requires BOTH ALLOW_REMOTE=1 and --apply ` +
        `(got ALLOW_REMOTE=${ALLOW_REMOTE ? "1" : "0"}, ${APPLY ? "--apply" : "no --apply"}).`
    );
  }
  console.log(`[migrate-assignedto-ref] ⚠  REMOTE APPLY authorized — writing to ${host}`);
  return host;
}

const isObjId = (v) => mongoose.isValidObjectId(v);

// Pure per-value resolution (exported for tests). `group` is the per-venue index
// { ids:Set<string>, byName:Map<name,_id>, byNameLower:Map<lowername,_id> }.
// Returns { id: ObjectId|null, how }. Order: empty → exact _id → exact name →
// case-insensitive name → unresolved.
function resolveAssignment(raw, group) {
  const s = raw == null ? "" : String(raw).trim();
  if (s === "") return { id: null, how: "empty" };
  if (group && isObjId(s) && group.ids.has(s)) return { id: new mongoose.Types.ObjectId(s), how: "by_id" };
  if (group && group.byName.has(s)) return { id: group.byName.get(s), how: "by_name_exact" };
  if (group && group.byNameLower.has(s.toLowerCase())) return { id: group.byNameLower.get(s.toLowerCase()), how: "by_name_ci" };
  return { id: null, how: "unresolved" };
}

async function run() {
  const host = assertMongoTarget();
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 8000 });
  console.log(`[migrate-assignedto-ref] connected @ ${host} (${APPLY ? "APPLY" : "DRY-RUN"})`);

  // Preload members grouped by venue: id set + exact-name + lowercase-name maps.
  const members = await VenueTeamMember.find({}).select("_id venueId name").lean();
  const byVenue = new Map(); // venueId -> { ids:Set, byName:Map, byNameLower:Map }
  for (const m of members) {
    const key = String(m.venueId);
    if (!byVenue.has(key)) byVenue.set(key, { ids: new Set(), byName: new Map(), byNameLower: new Map() });
    const g = byVenue.get(key);
    g.ids.add(String(m._id));
    if (m.name) {
      g.byName.set(m.name, m._id);
      g.byNameLower.set(String(m.name).toLowerCase(), m._id);
    }
  }

  // Read raw values (native collection) so legacy strings aren't cast away.
  const docs = await VenueEnquiry.collection
    .find({}, { projection: { _id: 1, venueId: 1, assignedTo: 1 } })
    .toArray();

  const stats = { total: docs.length, already_ref: 0, empty: 0, by_id: 0, by_name_exact: 0, by_name_ci: 0, unresolved: 0 };
  const updates = []; // { _id, assignedTo: ObjectId|null }
  const backup = [];
  const unresolvedLog = [];

  for (const d of docs) {
    const av = d.assignedTo;
    const venueKey = String(d.venueId);
    const g = byVenue.get(venueKey);

    if (av instanceof mongoose.Types.ObjectId) {
      stats.already_ref++;
      continue; // already a ref — nothing to do
    }
    const { id: resolved, how } = resolveAssignment(av, g);
    if (how === "empty") {
      stats.empty++;
      // Normalize any legacy "" to a real null only when applying.
      if (av !== null && av !== undefined) { updates.push({ _id: d._id, assignedTo: null }); backup.push({ _id: d._id, venueId: d.venueId, assignedTo: av }); }
      continue;
    }
    stats[how]++;
    if (how === "unresolved") unresolvedLog.push({ enquiry: String(d._id), venue: venueKey, value: String(av).trim() });
    updates.push({ _id: d._id, assignedTo: resolved });
    backup.push({ _id: d._id, venueId: d.venueId, assignedTo: av });
  }

  console.log(`[migrate-assignedto-ref] ${stats.total} enquiries scanned`);
  console.log(`  already ObjectId : ${stats.already_ref}`);
  console.log(`  empty → null     : ${stats.empty}`);
  console.log(`  resolved by _id  : ${stats.by_id}`);
  console.log(`  resolved by name : ${stats.by_name_exact} (exact) + ${stats.by_name_ci} (case-insensitive)`);
  console.log(`  UNRESOLVED → null: ${stats.unresolved}`);
  if (unresolvedLog.length) {
    console.log(`[migrate-assignedto-ref] unresolved (manual reassignment needed):`);
    for (const u of unresolvedLog) console.log(`    enquiry ${u.enquiry} (venue ${u.venue}) had assignedTo="${u.value}"`);
  }

  if (!APPLY) {
    console.log(`[migrate-assignedto-ref] DRY-RUN — ${updates.length} doc(s) would be written. Re-run with --apply.`);
  } else if (updates.length === 0) {
    console.log(`[migrate-assignedto-ref] nothing to write.`);
  } else {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/:/g, "-");
    const backupPath = path.join(BACKUP_DIR, `assignedto-ref-${stamp}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
    console.log(`[migrate-assignedto-ref] backed up ${backup.length} prior value(s) → ${backupPath}`);

    const ops = updates.map((u) => ({ updateOne: { filter: { _id: u._id }, update: { $set: { assignedTo: u.assignedTo } } } }));
    const result = await VenueEnquiry.collection.bulkWrite(ops, { ordered: false });
    console.log(`[migrate-assignedto-ref] wrote ${result.modifiedCount} doc(s).`);
  }

  await mongoose.disconnect();
  console.log("[migrate-assignedto-ref] DONE");
}

if (require.main === module) {
  run().catch((err) => {
    console.error(`[migrate-assignedto-ref] FAILED: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { resolveAssignment };
