/**
 * scripts/backfill-token-paid.js
 *
 * S4 derives a milestone's status from paidAmount vs amount vs dueDate. Every
 * booking confirmed BEFORE that slice has a token row written by the old path:
 *
 *     { label: "Token — received (UPI)", amount: 300000, dueDate: <confirmed at> }
 *
 * with no paidAmount — because the field did not exist. Under the new
 * derivation that row reads as UNPAID and, since its dueDate is the day the
 * booking was confirmed, immediately OVERDUE. So every historical booking that
 * took a token would show:
 *
 *   · a false overdue alert on the lead, on Today and in the payments summary
 *   · a balance overstated by the token amount
 *
 * Which is precisely the alert-noise problem S4 was written to remove,
 * reintroduced by the migration rather than by the code. The token was money in
 * hand on the day; this records that it was.
 *
 * ── WHAT IT CHANGES, AND WHAT IT DELIBERATELY DOES NOT ──────────────────────
 * ONLY token rows, identified by the label the old confirm path wrote. Other
 * schedule rows were genuinely future or genuinely due, and marking any of them
 * paid would invent a payment that never happened — the opposite error, and a
 * far worse one, since it would hide real money owed.
 *
 * paidAt is set to the row's dueDate (the confirmation timestamp), which is the
 * best evidence available of when the token actually arrived. paidMode is read
 * out of the label when the old code recorded one there; when it did not, the
 * mode is left empty rather than guessed.
 *
 * `percent` is NOT backfilled. A row with no percent reads correctly as "amount
 * only" — that is what those schedules were — and inventing percentages would
 * put numbers on a customer's confirmation that nobody agreed.
 *
 * IDEMPOTENT: a row that already has paidAmount > 0 is skipped, so a second run
 * is a no-op and a partially-applied run can be resumed.
 *
 * SAFETY: refuses a non-local Mongo unless the operator sets BOTH ALLOW_REMOTE=1
 * and --apply. Dry-run by default. Nothing is written before a full pre-state
 * backup lands in scripts/backups/.
 *
 * Usage:
 *   node scripts/backfill-token-paid.js                        # local dry-run (default)
 *   node scripts/backfill-token-paid.js --apply                # local apply
 *   ALLOW_REMOTE=1 node scripts/backfill-token-paid.js --apply # PROD (both gates)
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const VenueBooking = require("../models/VenueBooking");
const { summarizeSchedule } = require("../utils/venuePaymentStatus");

const TAG = "backfill-token-paid";
const BACKUP_DIR = path.join(__dirname, "backups");
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);
const APPLY = process.argv.includes("--apply");
const ALLOW_REMOTE = process.env.ALLOW_REMOTE === "1";

/** The label the old confirm path wrote, with or without a bracketed mode. */
const TOKEN_LABEL_RE = /^Token\s*—\s*received(?:\s*\((.+)\))?$/i;
const KNOWN_MODES = ["bank_transfer", "cash", "cheque", "upi", "card"];

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

/** Normalise whatever the old code put in the brackets into a stored mode. */
function modeFromLabel(label) {
  const m = TOKEN_LABEL_RE.exec(String(label || "").trim());
  if (!m || !m[1]) return "";
  const raw = m[1].trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (KNOWN_MODES.includes(raw)) return raw;
  if (/bank/.test(raw)) return "bank_transfer";
  if (/upi/.test(raw)) return "upi";
  if (/cash/.test(raw)) return "cash";
  if (/cheque|check/.test(raw)) return "cheque";
  if (/card/.test(raw)) return "card";
  // Free text the enum cannot hold ("Gpay to Rohaan"). Left empty rather than
  // forced into the nearest option — a wrong method on a payment record is a
  // fact nobody entered.
  return "";
}

async function run() {
  const host = assertMongoTarget();
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 8000 });
  console.log(`[${TAG}] connected @ ${host}\n`);

  const bookings = await VenueBooking.find({ "paymentSchedule.0": { $exists: true } })
    .select("_id coupleName totalValue paymentSchedule createdAt")
    .lean();

  const plans = [];
  let alreadyPaid = 0;
  let noTokenRow = 0;

  for (const b of bookings) {
    const rows = b.paymentSchedule || [];
    const tokenRows = rows.filter((r) => TOKEN_LABEL_RE.test(String(r.label || "").trim()));
    if (!tokenRows.length) {
      noTokenRow += 1;
      continue;
    }
    const needing = tokenRows.filter((r) => !(Number(r.paidAmount) > 0) && Number(r.amount) > 0);
    if (!needing.length) {
      alreadyPaid += 1;
      continue;
    }
    // What the alerts say TODAY, before the fix — the number that makes the case.
    const before = summarizeSchedule(b);
    plans.push({
      bookingId: b._id,
      coupleName: b.coupleName || "(unnamed)",
      totalValue: Number(b.totalValue) || 0,
      rows: needing.map((r) => ({
        _id: r._id,
        label: r.label,
        amount: Number(r.amount) || 0,
        paidAt: r.dueDate || b.createdAt || new Date(),
        mode: modeFromLabel(r.label),
      })),
      falselyOverdue: before.overdue.filter((o) => TOKEN_LABEL_RE.test(o.label)).length,
      balanceBefore: before.totals.balance,
    });
  }

  const tokenRowCount = plans.reduce((n, p) => n + p.rows.length, 0);
  const tokenValue = plans.reduce((n, p) => n + p.rows.reduce((s, r) => s + r.amount, 0), 0);
  const falseAlerts = plans.reduce((n, p) => n + p.falselyOverdue, 0);
  const modeless = plans.reduce((n, p) => n + p.rows.filter((r) => !r.mode).length, 0);

  console.log(`── SCANNED ────────────────────────────────────────`);
  console.log(`   bookings with a schedule ......... ${bookings.length}`);
  console.log(`   …no token row (nothing to do) .... ${noTokenRow}`);
  console.log(`   …token already recorded paid ..... ${alreadyPaid}`);
  console.log(`   …TOKEN ROWS TO BACKFILL .......... ${plans.length} booking(s), ${tokenRowCount} row(s)`);
  console.log(`\n── IMPACT ─────────────────────────────────────────`);
  console.log(`   false overdue alerts removed ..... ${falseAlerts}`);
  console.log(`   balance over-stated by, in total .. Rs. ${tokenValue.toLocaleString("en-IN")}`);
  console.log(`   rows whose method cannot be read .. ${modeless} (left empty, never guessed)`);

  if (plans.length) {
    console.log(`\n── PER BOOKING ────────────────────────────────────`);
    const verb = APPLY ? "" : "would ";
    for (const p of plans.slice(0, 40)) {
      for (const r of p.rows) {
        console.log(
          `   ${verb}mark paid  ${p.bookingId}  "${p.coupleName}"  ${r.label}  ` +
            `Rs. ${r.amount.toLocaleString("en-IN")}  on ${new Date(r.paidAt).toISOString().slice(0, 10)}` +
            `${r.mode ? `  via ${r.mode}` : "  (method unknown)"}`
        );
      }
      console.log(`        balance ${p.balanceBefore.toLocaleString("en-IN")} → ${(p.balanceBefore - p.rows.reduce((s, r) => s + r.amount, 0)).toLocaleString("en-IN")}`);
    }
    if (plans.length > 40) console.log(`   … and ${plans.length - 40} more booking(s) not listed`);
  }

  if (!APPLY) {
    console.log(`\n[${TAG}] DRY-RUN — nothing written. Re-run with --apply to write.`);
    await mongoose.disconnect();
    console.log(`[${TAG}] DONE`);
    return;
  }
  if (!plans.length) {
    console.log(`\n[${TAG}] nothing to do — already clean.`);
    await mongoose.disconnect();
    console.log(`[${TAG}] DONE`);
    return;
  }

  // ── backup-first: the full pre-state of every row about to change ────────
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(BACKUP_DIR, `token-paid-premigration-${stamp}.json`);
  fs.writeFileSync(
    backupPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        host,
        bookings: plans.map((p) => ({
          bookingId: String(p.bookingId),
          coupleName: p.coupleName,
          balanceBefore: p.balanceBefore,
          rows: p.rows.map((r) => ({ _id: String(r._id), label: r.label, amount: r.amount, paidAmountBefore: 0 })),
        })),
      },
      null,
      2
    )
  );
  console.log(`\n[${TAG}] backup written → ${backupPath}`);

  let updated = 0;
  let failed = 0;
  for (const p of plans) {
    for (const r of p.rows) {
      try {
        // The filter re-asserts paidAmount is still unset ON THIS ROW, so a
        // payment recorded by a human between the scan and here is never
        // overwritten. $elemMatch is load-bearing: as two sibling predicates
        // the id and the paidAmount conditions can be satisfied by DIFFERENT
        // array elements while $ still resolves to this one, so a token row
        // that a human had just paid was overwritten whenever any other row in
        // the schedule was unpaid — which is nearly always. Found in review.
        const res = await VenueBooking.updateOne(
          { _id: p.bookingId, paymentSchedule: { $elemMatch: { _id: r._id, $or: [{ paidAmount: 0 }, { paidAmount: { $exists: false } }] } } },
          {
            $set: {
              "paymentSchedule.$.paidAmount": r.amount,
              "paymentSchedule.$.paidAt": r.paidAt,
              ...(r.mode ? { "paymentSchedule.$.paidMode": r.mode } : {}),
              "paymentSchedule.$.paidReference": "Backfilled — token recorded at confirmation",
            },
          }
        );
        if (res.modifiedCount === 1) updated += 1;
        else console.log(`   – ${p.bookingId} ${r.label}: already paid or gone; left alone`);
      } catch (e) {
        failed += 1;
        console.error(`   ✗ ${p.bookingId} ${r.label}: ${e.message}`);
      }
    }
  }

  console.log(`\n[${TAG}] marked ${updated} token row(s) paid, failed ${failed}`);
  await mongoose.disconnect();
  console.log(`[${TAG}] DONE`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error(`[${TAG}] FAILED: ${err.message}`);
  process.exit(1);
});
