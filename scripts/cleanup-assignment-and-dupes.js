/**
 * scripts/cleanup-assignment-and-dupes.js
 *
 * Data correction for the three things PR #124 fixed forward but could not
 * retroactively repair. Three independent sections, each separately tallied:
 *
 *   A. UNASSIGNED, MANUALLY CREATED  → assign to the venue's owner member row.
 *      createManualLead read req.venueOwner.memberId, which is undefined for an
 *      owner token, so leads an owner typed in landed unassigned. These are the
 *      leads whose creator-default should have fired and didn't.
 *
 *      NOTE ON THE FILTER — this deliberately does NOT key on activities.via.
 *      Pre-fix, the via-bearing activity was only pushed when an assignment
 *      SUCCEEDED:
 *          const activities = [{ type: "created", … }];
 *          if (assign.assignedTo) activities.push({ …, via: assign.via, … });
 *      so exactly the leads we are looking for carry no via stamp at all. A
 *      via-keyed query returns 0 by construction. The unconditional
 *      type:"created" + "Lead added manually" marker is the correct handle.
 *
 *   B. UNASSIGNED, EVERYTHING ELSE  → assign to the venue's owner member row.
 *      Public intake, dedup-into-existing, imports. Same mechanism, but a
 *      DISTINCT `via` so the two populations never blur in the audit trail:
 *      section A is "a default that failed", section B is "a backlog we swept".
 *      Ten minutes or ten months from now, that distinction is the difference
 *      between a bug's blast radius and an operational decision.
 *
 *   C. STRAY notes[] ROWS WITH AN activities[] TWIN  → $pull the note.
 *      logOnLinkedLead used to push the SAME text into both arrays, and
 *      buildTimeline merges them, so every hold rendered twice at one
 *      timestamp. The activities[] row is the keeper — a hold is machine
 *      bookkeeping, not something a human typed into the Notes tab.
 *
 *      ON TIMESTAMP MATCHING — the two pushes evaluated `new Date()`
 *      SEPARATELY inside one $push, so they usually share a millisecond but are
 *      not guaranteed to. Exact equality would therefore silently fail to clean
 *      genuine duplicates. A tight tolerance window (default 2000ms, see
 *      --twin-window-ms) is the honest reading of "match on timestamp too": it
 *      is still vastly stricter than text alone, which is the actual hazard —
 *      a human note that happens to quote the machine's wording must survive.
 *      A note is pulled by its own subdocument _id, so exactly one row goes,
 *      even if a lead legitimately holds two identical notes.
 *
 *      Only the three machine-written hold texts are ever pulled. Any OTHER
 *      note that happens to have a twin is REPORTED and left alone — this
 *      script cleans a known double-write, it does not de-duplicate prose.
 *
 * Idempotent: a second run finds nothing. Assigned leads no longer match the
 * unassigned filter; pulled notes no longer exist.
 *
 * SAFETY: refuses to run against a non-local Mongo UNLESS the operator
 * deliberately opts in with BOTH `ALLOW_REMOTE=1` and `--apply`. Local hosts
 * (127.0.0.1/localhost) always allowed. The resolved host is printed on every
 * run. Dry-run is the default. Nothing is written before a full pre-state
 * backup lands in scripts/backups/.
 *
 * Usage:
 *   node scripts/cleanup-assignment-and-dupes.js                        # local dry-run (default)
 *   node scripts/cleanup-assignment-and-dupes.js --apply                # local apply
 *   ALLOW_REMOTE=1 node scripts/cleanup-assignment-and-dupes.js --apply # PROD (both gates)
 *
 *   --only=A|B|C          run one section
 *   --twin-window-ms=N    tolerance for the notes/activities timestamp match
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueTeamMember = require("../models/VenueTeamMember");

const TAG = "assign-cleanup";
const BACKUP_DIR = path.join(__dirname, "backups");
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);
const APPLY = process.argv.includes("--apply");
const ALLOW_REMOTE = process.env.ALLOW_REMOTE === "1";

const argOf = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : dflt;
};
const ONLY = String(argOf("only", "")).toUpperCase();
const runs = (s) => !ONLY || ONLY === s;
const TWIN_WINDOW_MS = Math.max(0, Number(argOf("twin-window-ms", 2000)) || 0);

// The three texts logOnLinkedLead ever wrote. Anchored so a human note merely
// QUOTING one of these ("they asked why Hold requested showed twice") does not
// match — the machine rows always start with the phrase.
const HOLD_TEXT_RE = /^(Hold requested for |Date held for them \(|Hold released — the date is open again\.)/;

// Section A vs B. `via` is the discriminator the user reads later; `type` stays
// one of the conventional values so existing timeline rendering is unaffected.
const VIA_A = "backfill_create_default";
const VIA_B = "backfill_unassigned_sweep";
const DESC_A = "Assigned to owner — the creator default did not fire when this lead was made";
const DESC_B = "Assigned to owner — swept from the unassigned backlog";

function assertMongoTarget() {
  const url = process.env.DATABASE_URL || "";
  let host;
  try {
    host = new URL(url).hostname;
  } catch (e) {
    throw new Error(`Cannot parse DATABASE_URL to verify host: ${e.message}`);
  }
  const isLocal = LOCAL_HOSTS.has(host);
  console.log(`[${TAG}] ┌───────────────────────────────────────────`);
  console.log(`[${TAG}] │ TARGET HOST: ${host}  (${isLocal ? "local" : "REMOTE"})`);
  console.log(`[${TAG}] │ MODE: ${APPLY ? "APPLY" : "DRY-RUN"}  ALLOW_REMOTE=${ALLOW_REMOTE ? "1" : "0"}`);
  console.log(`[${TAG}] │ SECTIONS: ${ONLY || "A, B, C"}   twin window: ${TWIN_WINDOW_MS}ms`);
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

/** venueId -> active owner member row id. Venues without one cannot be repaired. */
async function ownerMemberIndex() {
  const rows = await VenueTeamMember.find({ isOwnerAccount: true, isActive: { $ne: false } })
    .select("_id venueId name")
    .lean();
  const byVenue = new Map();
  for (const r of rows) {
    // A venue should have exactly one. If somehow two, take the earliest so the
    // choice is stable across runs rather than dependent on result ordering.
    const key = String(r.venueId);
    const prev = byVenue.get(key);
    if (!prev || String(r._id) < String(prev._id)) byVenue.set(key, r);
  }
  return byVenue;
}

const UNASSIGNED = { deleted: { $ne: true }, $or: [{ assignedTo: null }, { assignedTo: { $exists: false } }] };
// The unconditional marker createManualLead always writes.
const MANUAL_MARK = { activities: { $elemMatch: { type: "created", description: "Lead added manually" } } };

async function planAssignments(owners) {
  const leads = await VenueEnquiry.find(UNASSIGNED)
    .select("_id venueId coupleName couplePhone createdAt activities")
    .lean();

  const plans = [];
  const noOwner = [];
  for (const l of leads) {
    const isManual = (l.activities || []).some(
      (a) => a.type === "created" && a.description === "Lead added manually"
    );
    const section = isManual ? "A" : "B";
    if (!runs(section)) continue;
    const owner = owners.get(String(l.venueId));
    if (!owner) {
      noOwner.push({ lead: l, section });
      continue;
    }
    plans.push({
      section,
      leadId: l._id,
      venueId: l.venueId,
      coupleName: l.coupleName,
      createdAt: l.createdAt,
      ownerMemberId: owner._id,
      ownerName: owner.name,
      via: isManual ? VIA_A : VIA_B,
      description: isManual ? DESC_A : DESC_B,
    });
  }
  return { plans, noOwner, scanned: leads.length };
}

async function planNotePulls() {
  const leads = await VenueEnquiry.find({ "notes.text": HOLD_TEXT_RE })
    .select("_id coupleName venueId notes activities")
    .lean();

  const pulls = [];
  const otherTwins = []; // reported, never touched
  for (const l of leads) {
    for (const n of l.notes || []) {
      const text = n.text || "";
      const at = n.addedAt ? +new Date(n.addedAt) : null;
      const twin = (l.activities || []).find((a) => {
        if ((a.description || "") !== text) return false;
        if (at === null || !a.timestamp) return false;
        return Math.abs(+new Date(a.timestamp) - at) <= TWIN_WINDOW_MS;
      });
      if (!twin) continue;
      if (!HOLD_TEXT_RE.test(text)) {
        otherTwins.push({ leadId: l._id, text: text.slice(0, 60) });
        continue;
      }
      if (!n._id) continue; // cannot target it precisely; leave it alone
      pulls.push({
        leadId: l._id,
        coupleName: l.coupleName,
        venueId: l.venueId,
        noteId: n._id,
        text,
        addedAt: n.addedAt,
        twinAt: twin.timestamp,
        driftMs: Math.abs(+new Date(twin.timestamp) - at),
      });
    }
  }
  return { pulls, otherTwins, scanned: leads.length };
}

function writeBackup(payload) {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const p = path.join(BACKUP_DIR, `assign-cleanup-premigration-${stamp}.json`);
  fs.writeFileSync(p, JSON.stringify(payload, null, 2));
  console.log(`[${TAG}] backup written → ${p}`);
  return p;
}

async function run() {
  const host = assertMongoTarget();
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 8000 });
  console.log(`[${TAG}] connected to Mongo @ ${host}\n`);

  const owners = await ownerMemberIndex();
  console.log(`[${TAG}] ${owners.size} venue(s) have an active owner member row\n`);

  const { plans, noOwner, scanned } = await planAssignments(owners);
  const secA = plans.filter((p) => p.section === "A");
  const secB = plans.filter((p) => p.section === "B");
  const { pulls, otherTwins, scanned: noteScanned } = runs("C")
    ? await planNotePulls()
    : { pulls: [], otherTwins: [], scanned: 0 };

  // ── per-item reporting ────────────────────────────────────────────────
  const verb = APPLY ? "" : "would ";
  if (runs("A")) {
    console.log(`── SECTION A · unassigned, manually created ──────────────────`);
    console.log(`   ${scanned} unassigned lead(s) scanned; ${secA.length} manually created`);
    for (const p of secA) {
      console.log(
        `   ${verb}assign ${p.leadId} "${p.coupleName}" (${new Date(p.createdAt).toISOString().slice(0, 10)}) ` +
          `→ ${p.ownerName} [${p.ownerMemberId}]  via=${p.via}`
      );
    }
  }
  if (runs("B")) {
    console.log(`\n── SECTION B · unassigned, every other source ────────────────`);
    console.log(`   ${secB.length} lead(s)`);
    for (const p of secB) {
      console.log(
        `   ${verb}assign ${p.leadId} "${p.coupleName}" (${new Date(p.createdAt).toISOString().slice(0, 10)}) ` +
          `→ ${p.ownerName} [${p.ownerMemberId}]  via=${p.via}`
      );
    }
  }
  if (noOwner.length) {
    console.log(`\n   ⚠ ${noOwner.length} lead(s) SKIPPED — their venue has no active owner member row:`);
    for (const s of noOwner) console.log(`     [${s.section}] ${s.lead._id} venue ${s.lead.venueId}`);
    console.log(`     Run scripts/migrate-owner-members.js first, then re-run this.`);
  }
  if (runs("C")) {
    console.log(`\n── SECTION C · stray notes[] rows with an activities[] twin ───`);
    console.log(`   ${noteScanned} lead(s) carry hold text in notes[]; ${pulls.length} row(s) have a matching twin`);
    for (const p of pulls) {
      console.log(`   ${verb}pull note ${p.noteId} from ${p.leadId} "${p.coupleName}"  (twin drift ${p.driftMs}ms)`);
      console.log(`        "${p.text.slice(0, 78)}"`);
    }
    if (otherTwins.length) {
      console.log(`   ℹ ${otherTwins.length} NON-hold note(s) also have an exact twin — reported only, NOT pulled:`);
      for (const o of otherTwins) console.log(`     ${o.leadId}  "${o.text}"`);
    }
  }

  // ── the three headline numbers ────────────────────────────────────────
  console.log(`\n[${TAG}] ══ TALLY ═══════════════════════════════════`);
  if (runs("A")) console.log(`[${TAG}]   A · manual→owner ......... ${secA.length}`);
  if (runs("B")) console.log(`[${TAG}]   B · other→owner .......... ${secB.length}`);
  if (runs("C")) console.log(`[${TAG}]   C · stray notes pulled ... ${pulls.length}`);
  if (noOwner.length) console.log(`[${TAG}]   – skipped (no owner row) . ${noOwner.length}`);
  console.log(`[${TAG}] ════════════════════════════════════════════`);

  if (!APPLY) {
    console.log(`\n[${TAG}] DRY-RUN — nothing written. Re-run with --apply to write.`);
    await mongoose.disconnect();
    console.log(`[${TAG}] DONE`);
    return;
  }

  if (!plans.length && !pulls.length) {
    console.log(`\n[${TAG}] nothing to do — already clean.`);
    await mongoose.disconnect();
    console.log(`[${TAG}] DONE`);
    return;
  }

  // ── backup-first: full pre-state of everything about to change ────────
  writeBackup({
    generatedAt: new Date().toISOString(),
    host,
    twinWindowMs: TWIN_WINDOW_MS,
    assignments: plans.map((p) => ({
      leadId: String(p.leadId),
      venueId: String(p.venueId),
      coupleName: p.coupleName,
      section: p.section,
      assignedToBefore: null,
      assignedToAfter: String(p.ownerMemberId),
      via: p.via,
    })),
    notePulls: pulls.map((p) => ({
      leadId: String(p.leadId),
      venueId: String(p.venueId),
      coupleName: p.coupleName,
      removedNote: { _id: String(p.noteId), text: p.text, addedAt: p.addedAt },
      twinTimestamp: p.twinAt,
      driftMs: p.driftMs,
    })),
  });

  const tally = { assigned: 0, pulled: 0, failed: 0 };
  for (const p of plans) {
    try {
      // Re-assert the unassigned precondition inside the write, so a lead
      // assigned by a human between the scan and here is never overwritten.
      const res = await VenueEnquiry.updateOne(
        { _id: p.leadId, $or: [{ assignedTo: null }, { assignedTo: { $exists: false } }] },
        {
          $set: { assignedTo: p.ownerMemberId },
          $push: {
            activities: {
              type: "manual_assigned",
              description: p.description,
              via: p.via,
              timestamp: new Date(),
            },
          },
        }
      );
      if (res.modifiedCount === 1) tally.assigned++;
      else console.log(`   – ${p.leadId} no longer unassigned; left alone`);
    } catch (err) {
      tally.failed++;
      console.error(`   ✗ assign ${p.leadId} failed — ${err.message}`);
    }
  }
  for (const p of pulls) {
    try {
      const res = await VenueEnquiry.updateOne({ _id: p.leadId }, { $pull: { notes: { _id: p.noteId } } });
      if (res.modifiedCount === 1) tally.pulled++;
      else console.log(`   – note ${p.noteId} already gone; left alone`);
    } catch (err) {
      tally.failed++;
      console.error(`   ✗ pull ${p.noteId} failed — ${err.message}`);
    }
  }

  console.log(`\n[${TAG}] assigned ${tally.assigned}, notes pulled ${tally.pulled}, failed ${tally.failed}`);
  const stillUnassigned = await VenueEnquiry.countDocuments(UNASSIGNED);
  console.log(`[${TAG}] ${stillUnassigned} unassigned lead(s) remain.`);

  await mongoose.disconnect();
  console.log(`[${TAG}] DONE`);
  if (tally.failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error(`[${TAG}] FAILED: ${err.message}`);
  process.exit(1);
});
