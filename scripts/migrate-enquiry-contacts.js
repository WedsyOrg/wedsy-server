/**
 * scripts/migrate-enquiry-contacts.js
 *
 * MB-CRM-2 S1a: seed the new VenueEnquiry.contacts[] from the legacy
 * coupleName/couplePhone (falling back to the name/phone mirrors). Per-doc:
 *   - contacts already non-empty            → skipped (idempotent)
 *   - no name AND no phone on the doc       → skipped (nothing to seed)
 *   - otherwise contacts = [{ name, phone, role:"other", isPrimary:true }]
 * ADDITIVE only; writes go through the native collection so no full-doc
 * validation (event-window hook etc.) runs on legacy rows.
 *
 * SAFETY (matches scripts/migrate-assignedto-ref.js): refuses a non-local
 * Mongo UNLESS BOTH ALLOW_REMOTE=1 and --apply are set. Local hosts always
 * allowed. Dry-run is the default and writes nothing; --apply backs up first
 * to scripts/backups/.
 *
 * Usage:
 *   node scripts/migrate-enquiry-contacts.js                         # local dry-run (default)
 *   node scripts/migrate-enquiry-contacts.js --apply                 # local backup + write
 *   ALLOW_REMOTE=1 node scripts/migrate-enquiry-contacts.js --apply  # PROD (both gates)
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const VenueEnquiry = require("../models/VenueEnquiry");

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
  console.log(`[migrate-enquiry-contacts] ┌───────────────────────────────────────────`);
  console.log(`[migrate-enquiry-contacts] │ TARGET HOST: ${host}  (${isLocal ? "local" : "REMOTE"})`);
  console.log(`[migrate-enquiry-contacts] │ MODE: ${APPLY ? "APPLY" : "DRY-RUN"}  ALLOW_REMOTE=${ALLOW_REMOTE ? "1" : "0"}`);
  console.log(`[migrate-enquiry-contacts] └───────────────────────────────────────────`);
  if (isLocal) return host;
  if (!ALLOW_REMOTE || !APPLY) {
    throw new Error(
      `Refusing to run: DATABASE_URL host "${host}" is REMOTE. The guarded ` +
        `production path requires BOTH ALLOW_REMOTE=1 and --apply ` +
        `(got ALLOW_REMOTE=${ALLOW_REMOTE ? "1" : "0"}, ${APPLY ? "--apply" : "no --apply"}).`
    );
  }
  console.log(`[migrate-enquiry-contacts] ⚠  REMOTE APPLY authorized — writing to ${host}`);
  return host;
}

// Pure per-doc seeding decision (exported for tests): given the raw legacy
// fields, returns the contacts array to write, or null when nothing to do.
// Precedence mirrors the read paths everywhere else: coupleName || name,
// couplePhone || phone.
function buildSeedContacts(doc) {
  if (Array.isArray(doc.contacts) && doc.contacts.length > 0) return null; // already migrated
  const name = String(doc.coupleName || doc.name || "").trim();
  const phone = String(doc.couplePhone || doc.phone || "").trim();
  if (!name && !phone) return null; // nothing to seed
  return [{ name, phone, role: "other", isPrimary: true }];
}

async function run() {
  const host = assertMongoTarget();
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 8000 });
  console.log(`[migrate-enquiry-contacts] connected @ ${host} (${APPLY ? "APPLY" : "DRY-RUN"})`);

  const docs = await VenueEnquiry.collection
    .find({}, { projection: { _id: 1, venueId: 1, coupleName: 1, couplePhone: 1, name: 1, phone: 1, contacts: 1 } })
    .toArray();

  const stats = { total: docs.length, already_migrated: 0, no_identity: 0, seeded: 0 };
  const updates = [];
  const backup = [];

  for (const d of docs) {
    const seed = buildSeedContacts(d);
    if (seed === null) {
      if (Array.isArray(d.contacts) && d.contacts.length > 0) stats.already_migrated++;
      else stats.no_identity++;
      continue;
    }
    stats.seeded++;
    updates.push({ _id: d._id, contacts: seed });
    backup.push({ _id: d._id, venueId: d.venueId, coupleName: d.coupleName, couplePhone: d.couplePhone, name: d.name, phone: d.phone, contacts: d.contacts });
  }

  console.log(`[migrate-enquiry-contacts] ${stats.total} enquiries scanned`);
  console.log(`  already migrated (contacts present): ${stats.already_migrated}`);
  console.log(`  no name/phone to seed from        : ${stats.no_identity}`);
  console.log(`  would seed contacts[0] isPrimary  : ${stats.seeded}`);

  if (!APPLY) {
    console.log(`[migrate-enquiry-contacts] DRY-RUN — ${updates.length} doc(s) would be written. Re-run with --apply.`);
  } else if (updates.length === 0) {
    console.log(`[migrate-enquiry-contacts] nothing to write.`);
  } else {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/:/g, "-");
    const backupPath = path.join(BACKUP_DIR, `enquiry-contacts-${stamp}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
    console.log(`[migrate-enquiry-contacts] backed up ${backup.length} prior value(s) → ${backupPath}`);

    const ops = updates.map((u) => ({ updateOne: { filter: { _id: u._id }, update: { $set: { contacts: u.contacts } } } }));
    const result = await VenueEnquiry.collection.bulkWrite(ops, { ordered: false });
    console.log(`[migrate-enquiry-contacts] wrote ${result.modifiedCount} doc(s).`);
  }

  await mongoose.disconnect();
  console.log("[migrate-enquiry-contacts] DONE");
}

if (require.main === module) {
  run().catch((err) => {
    console.error(`[migrate-enquiry-contacts] FAILED: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { buildSeedContacts };
