/**
 * scripts/migrate-contact-relations.js — BUILD A backfill.
 *
 * Three additive backfills on VenueEnquiry, all of them safe to re-run:
 *
 *   1. contacts[].role → contacts[].relation, mapped into the new
 *      type-keyed vocabulary. `role` is LEFT IN PLACE as the record of what was
 *      originally entered — nothing is destroyed.
 *
 *   2. eventType = "social" on every row that predates the field. Reads are
 *      already safe (cleanEventType treats undefined as social), but a QUERY
 *      like { eventType: "social" } would not match a row where the field is
 *      absent, so the column is materialised.
 *
 *   3. coupleNameManual = true on every row that already has a name.
 *
 * ── WHY (3) FREEZES EXISTING NAMES ───────────────────────────────────────────
 * This is the judgement call in the script and it goes the conservative way.
 * Today's coupleName is whatever a human typed or whatever the primary contact
 * was called. If the migration left these rows open to derivation, then the
 * first time anyone added bride and groom contacts to an old lead, its name
 * would silently change — "Aarav & Diya" could become something else across the
 * whole existing book, invisibly, with no audit trail and no undo. A rename you
 * did not ask for is worse than a name that is merely not as good as it could
 * be. So existing names are frozen, and the row is handed to the derivation the
 * moment someone CLEARS the name field, which is the explicit opt-in.
 *
 * ── THE `mother` PROBLEM, and why it is not guessed ──────────────────────────
 * The old vocabulary had a generic `mother`. The new one distinguishes
 * brides_mother from grooms_mother, and the old data does not say which. Rather
 * than guess and be wrong half the time, `mother` maps to `other` and every
 * such row is COUNTED and reported so a human can re-tag them. The original
 * value survives in `role`, so nothing is lost — only deferred.
 *
 * SAFETY (house convention): dry-run by default; a remote target needs BOTH
 * ALLOW_REMOTE=1 and --apply; --apply writes a backup of every affected row to
 * scripts/backups/ BEFORE touching anything; idempotent.
 *
 *   node scripts/migrate-contact-relations.js                          # local dry-run
 *   node scripts/migrate-contact-relations.js --apply                  # local backup + write
 *   ALLOW_REMOTE=1 node scripts/migrate-contact-relations.js --apply   # PROD (both gates)
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const VenueEnquiry = require("../models/VenueEnquiry");
const { relationAllowed } = require("../utils/venueEventType");

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);
const APPLY = process.argv.includes("--apply");
const ALLOW_REMOTE = process.env.ALLOW_REMOTE === "1";
const BACKUP_DIR = path.join(__dirname, "backups");
const TAG = "[migrate-contact-relations]";

/**
 * Old enum → new relation. Every mapping here is an identity or a documented
 * widening; the only lossy one is `mother`, which is reported separately.
 */
const RELATION_MAP = {
  bride: "bride",
  groom: "groom",
  brides_father: "brides_father",
  planner: "planner",
  other: "other",
  // AMBIGUOUS — the old vocabulary could not say whose mother. Deferred to a
  // human rather than guessed; the original stays in `role`.
  mother: "other",
};
const AMBIGUOUS = new Set(["mother"]);

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

function writeBackup(rows) {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(BACKUP_DIR, `contact-relations-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({ takenAt: new Date().toISOString(), rows }, null, 2));
  return file;
}

async function run() {
  const host = assertMongoTarget();
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 8000 });
  console.log(`${TAG} connected @ ${host} (${APPLY ? "APPLY" : "DRY-RUN"})`);

  const total = await VenueEnquiry.countDocuments({});
  const leads = await VenueEnquiry.find({})
    .select("coupleName coupleNameManual eventType contacts")
    .lean();

  const tally = {
    leads: total,
    leadsWithContacts: 0,
    contactsSeen: 0,
    contactsMapped: 0,
    contactsAlreadyDone: 0,
    ambiguousMother: 0,
    unknownRole: 0,
    eventTypeBackfill: 0,
    coupleNameFrozen: 0,
    leadsTouched: 0,
  };
  const byRelation = {};
  const ops = [];
  const backup = [];

  for (const l of leads) {
    const set = {};
    const contacts = Array.isArray(l.contacts) ? l.contacts : [];
    if (contacts.length) tally.leadsWithContacts++;

    let contactsChanged = false;
    const nextContacts = contacts.map((c) => {
      tally.contactsSeen++;
      const existing = typeof c.relation === "string" ? c.relation : "";
      if (existing && relationAllowed("social", existing) === false && relationAllowed("corporate", existing) === false) {
        // A relation already set but outside both vocabularies — leave it for a
        // human rather than silently rewriting.
        tally.unknownRole++;
      }
      if (existing) {
        tally.contactsAlreadyDone++;
        byRelation[existing] = (byRelation[existing] || 0) + 1;
        return c;
      }
      const oldRole = typeof c.role === "string" ? c.role : "other";
      const mapped = RELATION_MAP[oldRole];
      if (mapped === undefined) tally.unknownRole++;
      if (AMBIGUOUS.has(oldRole)) tally.ambiguousMother++;
      const relation = mapped || "other";
      byRelation[relation] = (byRelation[relation] || 0) + 1;
      tally.contactsMapped++;
      contactsChanged = true;
      return { ...c, relation };
    });
    if (contactsChanged) set.contacts = nextContacts;

    if (l.eventType === undefined || l.eventType === null) {
      set.eventType = "social";
      tally.eventTypeBackfill++;
    }
    // Freeze an existing name — see the header for why this is the safe way.
    if (l.coupleNameManual !== true && typeof l.coupleName === "string" && l.coupleName.trim()) {
      set.coupleNameManual = true;
      tally.coupleNameFrozen++;
    }

    if (Object.keys(set).length === 0) continue;
    tally.leadsTouched++;
    backup.push({
      _id: l._id,
      coupleName: l.coupleName ?? null,
      coupleNameManual: l.coupleNameManual ?? null,
      eventType: l.eventType ?? null,
      contacts: contacts,
    });
    ops.push({ updateOne: { filter: { _id: l._id }, update: { $set: set } } });
  }

  console.log(`\n${TAG} LEADS`);
  console.log(`  ${tally.leads} total · ${tally.leadsWithContacts} with contacts · ${tally.leadsTouched} would change`);
  console.log(`\n${TAG} CONTACT RELATIONS`);
  console.log(`  ${tally.contactsSeen} contacts seen · ${tally.contactsMapped} would map · ${tally.contactsAlreadyDone} already set`);
  console.log(`  mapping: ${Object.entries(RELATION_MAP).map(([k, v]) => `${k}→${v}`).join(" · ")}`);
  const rel = Object.entries(byRelation).sort((a, b) => b[1] - a[1]);
  console.log(`  resulting spread: ${rel.length ? rel.map(([k, n]) => `${k}=${n}`).join(" · ") : "(none)"}`);
  if (tally.ambiguousMother > 0) {
    console.log(`  ⚠  ${tally.ambiguousMother} contact(s) had the ambiguous legacy role "mother" — mapped to "other".`);
    console.log(`     The old vocabulary could not say WHOSE mother; the original survives in \`role\`.`);
    console.log(`     These need a human to re-tag as brides_mother / grooms_mother.`);
  }
  if (tally.unknownRole > 0) console.log(`  ⚠  ${tally.unknownRole} contact(s) had a role outside both vocabularies — left alone.`);

  console.log(`\n${TAG} OTHER BACKFILLS`);
  console.log(`  eventType → "social": ${tally.eventTypeBackfill}`);
  console.log(`  coupleNameManual → true (existing names FROZEN): ${tally.coupleNameFrozen}`);
  console.log(`     Clearing a lead's name hands that row back to the derivation — that is the opt-in.`);

  if (!APPLY) {
    console.log(`\n${TAG} DRY-RUN — nothing written. Re-run with --apply.`);
    await mongoose.disconnect();
    console.log(`${TAG} DONE`);
    return;
  }

  if (!ops.length) {
    console.log(`\n${TAG} nothing to do.`);
    await mongoose.disconnect();
    return;
  }
  const file = writeBackup(backup);
  console.log(`\n${TAG} backed up ${backup.length} row(s) → ${file}`);
  const r = await VenueEnquiry.bulkWrite(ops, { ordered: false });
  console.log(`${TAG} modified ${r.modifiedCount || 0} document(s)`);
  await mongoose.disconnect();
  console.log(`${TAG} DONE`);
}

run().catch((err) => {
  console.error(`${TAG} FAILED: ${err.message}`);
  process.exit(1);
});
