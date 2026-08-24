/**
 * scripts/migrate-payment-entries.js
 *
 * S1 turns a milestone's `paidAmount` scalar into a list of payment ENTRIES.
 * This converts the rows written before that slice: every row with
 * paidAmount > 0 becomes exactly ONE approved entry carrying the same money,
 * and the scalar is zeroed.
 *
 * ── WHY THIS IS A CLEANUP AND NOT A PREREQUISITE ────────────────────────────
 * utils/venuePaymentStatus reads `entries` when a row has any and falls back to
 * the legacy scalar when it does not, so an un-migrated row already reports the
 * right balance everywhere. Nothing breaks if this never runs. What it buys is
 * a single shape in the database, so the fallback can eventually be deleted.
 *
 * The one thing it must not do is run HALF way and leave a row with both a
 * scalar and entries — the derivation would then ignore the scalar. Each row is
 * converted and zeroed in the same document write, so a row is either fully
 * legacy or fully converted, never between.
 *
 * ── IT SHARES ITS CONVERSION WITH THE LIVE PATH ─────────────────────────────
 * The actual field mapping is utils/venuePaymentEntries.convertLegacyRow, which
 * is the same function controllers/venueLeadPayment calls when a payment lands
 * on a still-legacy row. Two implementations of "what does this scalar become"
 * would drift, and the migration would then produce a different history than
 * the code that ran before it.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 * · Rows with paidAmount = 0 are untouched. There is no payment to record, and
 *   writing a zero-amount entry would put a payment that never happened into a
 *   couple's history (the schema refuses it anyway: entries require min 1).
 * · Rows that already have entries are skipped, so a second run is a no-op and
 *   a partially-applied run can be resumed.
 * · `status` is always "approved", which is accurate rather than merely
 *   convenient: production has zero team members, so every one of these was
 *   recorded by an owner, and an owner's own entry auto-approves under S3 too.
 * · The entry's date is the row's paidAt, falling back to its dueDate. Dating
 *   them to the migration run would make every historical payment claim to have
 *   arrived today — a lie in the one record that settles disputes.
 *
 * SAFETY: refuses a non-local Mongo unless the operator sets BOTH ALLOW_REMOTE=1
 * and --apply. Dry-run by default. Nothing is written before a full pre-state
 * backup lands in scripts/backups/.
 *
 * Usage:
 *   node scripts/migrate-payment-entries.js                        # local dry-run (default)
 *   node scripts/migrate-payment-entries.js --apply                # local apply
 *   ALLOW_REMOTE=1 node scripts/migrate-payment-entries.js --apply # PROD (both gates)
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const VenueBooking = require("../models/VenueBooking");
const { summarizeSchedule } = require("../utils/venuePaymentStatus");
const { convertLegacyRow } = require("../utils/venuePaymentEntries");

const TAG = "migrate-payment-entries";
const BACKUP_DIR = path.join(__dirname, "backups");
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);
const APPLY = process.argv.includes("--apply");
const ALLOW_REMOTE = process.env.ALLOW_REMOTE === "1";

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
      `Refusing to run: DATABASE_URL host "${host}" is REMOTE. ` +
        `The guarded production path requires BOTH ALLOW_REMOTE=1 and --apply ` +
        `(got ALLOW_REMOTE=${ALLOW_REMOTE ? "1" : "0"}, ${APPLY ? "--apply" : "no --apply"}).`
    );
  }
  console.log(`[${TAG}] ⚠  REMOTE APPLY authorized (ALLOW_REMOTE=1 + --apply) — writing to ${host}`);
  return host;
}

async function run() {
  const host = assertMongoTarget();
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 8000 });
  console.log(`[${TAG}] connected @ ${host}\n`);

  const bookings = await VenueBooking.find({ "paymentSchedule.0": { $exists: true } })
    .select("_id coupleName totalValue paymentSchedule createdAt")
    .lean();

  const plans = [];
  let alreadyConverted = 0;
  let nothingPaid = 0;

  for (const b of bookings) {
    const rows = b.paymentSchedule || [];
    const legacyRows = rows.filter((r) => (r.entries || []).length === 0 && Math.round(Number(r.paidAmount) || 0) > 0);
    if (!legacyRows.length) {
      if (rows.some((r) => (r.entries || []).length > 0)) alreadyConverted += 1;
      else nothingPaid += 1;
      continue;
    }

    // The balance BEFORE, from the live derivation. It must be identical after —
    // this migration moves money between shapes, it does not change any number.
    const before = summarizeSchedule(b);
    const simulated = JSON.parse(JSON.stringify(b));
    let converted = 0;
    for (const r of simulated.paymentSchedule || []) {
      if (convertLegacyRow(r)) converted += 1;
    }
    const after = summarizeSchedule(simulated);

    plans.push({
      bookingId: b._id,
      coupleName: b.coupleName || "",
      converted,
      beforeReceived: before.totals.received,
      afterReceived: after.totals.received,
      beforeBalance: before.totals.balance,
      afterBalance: after.totals.balance,
      // A mismatch here means the conversion LOST money. It is reported per
      // booking and blocks the apply — a migration that changes a balance is
      // not this migration.
      agrees: before.totals.received === after.totals.received && before.totals.balance === after.totals.balance,
      rows: legacyRows.map((r) => ({
        _id: String(r._id),
        label: r.label,
        amount: Math.round(Number(r.amount) || 0),
        paidAmount: Math.round(Number(r.paidAmount) || 0),
        paidAt: r.paidAt || null,
        paidMode: r.paidMode || "",
      })),
    });
  }

  const disagreeing = plans.filter((p) => !p.agrees);
  const totalRows = plans.reduce((s, p) => s + p.converted, 0);
  const totalMoney = plans.reduce((s, p) => s + p.rows.reduce((t, r) => t + r.paidAmount, 0), 0);

  console.log(`[${TAG}] bookings with a schedule ......... ${bookings.length}`);
  console.log(`[${TAG}] already converted (have entries) . ${alreadyConverted}`);
  console.log(`[${TAG}] nothing paid, nothing to do ...... ${nothingPaid}`);
  console.log(`[${TAG}] bookings to convert .............. ${plans.length}`);
  console.log(`[${TAG}] milestone rows to convert ........ ${totalRows}`);
  console.log(`[${TAG}] money moved into entries ......... Rs. ${totalMoney.toLocaleString("en-IN")}`);
  console.log(`[${TAG}] balance disagreements ............ ${disagreeing.length}\n`);

  for (const p of plans) {
    console.log(
      `[${TAG}]  ${p.agrees ? "·" : "✗"} ${String(p.bookingId)}  ${p.coupleName || "(no name)"} — ` +
        `${p.converted} row(s), received ${p.beforeReceived} → ${p.afterReceived}, balance ${p.beforeBalance} → ${p.afterBalance}`
    );
    for (const r of p.rows) {
      console.log(`[${TAG}]      ${r.label || "(no label)"}: Rs. ${r.paidAmount.toLocaleString("en-IN")} of ${r.amount.toLocaleString("en-IN")}${r.paidMode ? ` by ${r.paidMode}` : ""}`);
    }
  }

  if (disagreeing.length) {
    console.log(`\n[${TAG}] ✗ REFUSING: ${disagreeing.length} booking(s) would change their received or balance.`);
    console.log(`[${TAG}]   This migration must be money-neutral. Investigate before applying.`);
    await mongoose.disconnect();
    process.exitCode = 1;
    return;
  }

  if (!APPLY) {
    console.log(`\n[${TAG}] DRY-RUN — nothing written. Re-run with --apply to write.`);
    await mongoose.disconnect();
    return;
  }

  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(BACKUP_DIR, `${TAG}-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(plans.map((p) => ({ bookingId: p.bookingId, rows: p.rows })), null, 2));
  console.log(`\n[${TAG}] pre-state backup → ${backupPath}`);

  let applied = 0;
  for (const p of plans) {
    // Re-read and convert through the DOCUMENT, so the schema validates every
    // entry it creates rather than trusting a hand-built $set.
    const doc = await VenueBooking.findById(p.bookingId);
    if (!doc) continue;
    let touched = 0;
    for (const r of doc.paymentSchedule || []) {
      if (convertLegacyRow(r)) touched += 1;
    }
    if (!touched) continue;
    await doc.save();
    applied += touched;
    console.log(`[${TAG}]   ✓ ${String(p.bookingId)} — ${touched} row(s)`);
  }
  console.log(`\n[${TAG}] applied: ${applied} row(s) converted.`);
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error(`[${TAG}] FAILED: ${err.message}`);
  try { await mongoose.disconnect(); } catch (e) { /* already down */ }
  process.exitCode = 1;
});
