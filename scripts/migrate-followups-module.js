/**
 * scripts/migrate-followups-module.js
 *
 * Follow-ups module migration: fold each lead's single followUpDate/followUpNote
 * into a real VenueFollowUp row, then leave the lead fields in place as the
 * "next open follow-up" mirror (utils/venueFollowUp.syncLeadNextFollowUp).
 *
 * Per-doc:
 *   - lead already has a VenueFollowUp row          → skipped (idempotent)
 *   - no followUpDate                               → skipped (nothing to fold)
 *   - terminal stage (booked/lost) with a stale date→ folded as CANCELLED, so
 *     history is preserved without resurrecting a next step on a closed lead
 *   - otherwise                                     → one OPEN follow-up:
 *       type "call" (the overwhelmingly common touch, and what quick-log
 *       defaults to), priority "normal", note = followUpNote,
 *       assignedTo = the lead's assignee, migratedFromLead = true
 *
 * ADDITIVE only: no lead field is cleared, so a rollback is "drop the
 * venuefollowups collection" and every pre-existing consumer keeps reading the
 * same mirror it always read.
 *
 * SAFETY (matches scripts/migrate-enquiry-contacts.js): refuses a non-local
 * Mongo UNLESS BOTH ALLOW_REMOTE=1 and --apply are set. Local hosts always
 * allowed. Dry-run is the default and writes nothing; --apply backs up first
 * to scripts/backups/.
 *
 * Usage:
 *   node scripts/migrate-followups-module.js                         # local dry-run (default)
 *   node scripts/migrate-followups-module.js --apply                 # local backup + write
 *   ALLOW_REMOTE=1 node scripts/migrate-followups-module.js --apply  # PROD (both gates)
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueFollowUp = require("../models/VenueFollowUp");

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);
const APPLY = process.argv.includes("--apply");
const ALLOW_REMOTE = process.env.ALLOW_REMOTE === "1";
const BACKUP_DIR = path.join(__dirname, "backups");
const TERMINAL = new Set(["booked", "lost"]);
const TAG = "migrate-followups-module";

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
  console.log(`[${TAG}] └───────────────────────────────────────────`);
  if (isLocal) return host;
  if (!ALLOW_REMOTE || !APPLY) {
    throw new Error(
      `Refusing to run: DATABASE_URL host "${host}" is REMOTE. The guarded ` +
        `production path requires BOTH ALLOW_REMOTE=1 and --apply ` +
        `(got ALLOW_REMOTE=${ALLOW_REMOTE ? "1" : "0"}, ${APPLY ? "--apply" : "no --apply"}).`
    );
  }
  console.log(`[${TAG}] ⚠  REMOTE APPLY authorized — writing to ${host}`);
  return host;
}

/**
 * Pure per-doc decision (exported for tests): given a lead, return the
 * follow-up row to create, or null when there is nothing to fold.
 */
function planFollowUpFor(lead) {
  if (!lead.followUpDate) return null;
  const due = new Date(lead.followUpDate);
  if (Number.isNaN(due.getTime())) return null;
  return {
    venue: lead.venueId,
    lead: lead._id,
    type: "call",
    dueAt: due,
    priority: "normal",
    note: lead.followUpNote || "",
    assignedTo: lead.assignedTo || null,
    // A closed lead's leftover date becomes history, not a live next step.
    status: TERMINAL.has(lead.stage) ? "cancelled" : "open",
    cancelReason: TERMINAL.has(lead.stage) ? "Lead closed before this follow-up" : "",
    cancelledAt: TERMINAL.has(lead.stage) ? new Date() : undefined,
    migratedFromLead: true,
    createdAt: lead.createdAt || new Date(),
    updatedAt: new Date(),
  };
}

async function main() {
  assertMongoTarget();
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

  const leads = await VenueEnquiry.find({ followUpDate: { $ne: null, $exists: true } })
    .select("_id venueId stage followUpDate followUpNote assignedTo createdAt deleted")
    .lean();

  // Idempotence: any lead that already owns a follow-up row is left alone.
  const already = new Set(
    (await VenueFollowUp.find({ lead: { $in: leads.map((l) => l._id) } }).select("lead").lean()).map((f) => String(f.lead))
  );

  const plans = [];
  let skippedExisting = 0, skippedNoDate = 0, deletedLeads = 0;
  for (const lead of leads) {
    if (already.has(String(lead._id))) { skippedExisting++; continue; }
    const plan = planFollowUpFor(lead);
    if (!plan) { skippedNoDate++; continue; }
    // Soft-deleted leads still get their row so nothing is lost if the lead is
    // ever restored; they are invisible everywhere because the read paths scope
    // through the lead.
    if (lead.deleted) deletedLeads++;
    plans.push(plan);
  }

  const openCount = plans.filter((p) => p.status === "open").length;
  const cancelledCount = plans.filter((p) => p.status === "cancelled").length;

  console.log(`[${TAG}] leads with a followUpDate : ${leads.length}`);
  console.log(`[${TAG}] already migrated (skipped): ${skippedExisting}`);
  console.log(`[${TAG}] unparseable date (skipped): ${skippedNoDate}`);
  console.log(`[${TAG}] to create                 : ${plans.length}  (open ${openCount}, cancelled-on-terminal ${cancelledCount})`);
  console.log(`[${TAG}]   of which on soft-deleted leads: ${deletedLeads}`);

  if (!APPLY) {
    console.log(`[${TAG}] DRY-RUN — nothing written. Re-run with --apply to write.`);
    const sample = plans.slice(0, 5).map((p) => ({ lead: String(p.lead), dueAt: p.dueAt, status: p.status, note: (p.note || "").slice(0, 40) }));
    if (sample.length) console.log(`[${TAG}] sample:`, JSON.stringify(sample, null, 2));
    return { planned: plans.length, applied: 0 };
  }

  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(BACKUP_DIR, `followups-premigration-${stamp}.json`);
  fs.writeFileSync(
    backupPath,
    JSON.stringify(
      leads.map((l) => ({ _id: String(l._id), followUpDate: l.followUpDate, followUpNote: l.followUpNote, stage: l.stage })),
      null,
      2
    )
  );
  console.log(`[${TAG}] backup written → ${backupPath}`);

  const res = await VenueFollowUp.collection.insertMany(plans, { ordered: false });
  console.log(`[${TAG}] inserted ${res.insertedCount} follow-up rows.`);
  console.log(`[${TAG}] lead.followUpDate/.followUpNote left untouched — they are now the module's mirror.`);
  return { planned: plans.length, applied: res.insertedCount };
}

if (require.main === module) {
  main()
    .then(() => mongoose.disconnect())
    .catch(async (err) => {
      console.error(`[${TAG}] FAILED:`, err.message);
      await mongoose.disconnect().catch(() => {});
      process.exit(1);
    });
}

module.exports = { planFollowUpFor };
