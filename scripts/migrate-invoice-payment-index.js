/**
 * scripts/migrate-invoice-payment-index.js
 *
 * S6 keys a lead invoice on the PAYMENT rather than the milestone, and the
 * database guarantee moves with it:
 *
 *   OLD  { enquiry, forMilestoneId }               unique, partial on enquiry
 *   NEW  { enquiry, forMilestoneId, forPaymentId } unique, partial on enquiry
 *
 * ── THIS IS A DROP, NOT AN ADD ──────────────────────────────────────────────
 * Both indexes can physically coexist, and that is the trap. Under the OLD one
 * a payment-keyed invoice {e, null, paymentId} and the booking-level invoice
 * {e, null, null} both read as {e, null} and COLLIDE — which is exactly the
 * pair S6 needs to allow. Leaving the old index in place does not soften the
 * new behaviour, it silently forbids it: every payment invoice on a lead that
 * already has a booking-level invoice would 409.
 *
 * Verified against a real mongod before writing this, both ways round.
 *
 * ── IT CANNOT LOSE A GUARANTEE ──────────────────────────────────────────────
 * Adding a third key only ever splits index entries apart, never merges them.
 * Every pair that was unique under {e, m} stays unique under {e, m, null},
 * because pre-S6 documents have no forPaymentId and Mongo indexes a missing
 * field as null. The build is therefore safe on existing data — checked here
 * before anything is dropped, so a collision is reported rather than
 * discovered halfway through.
 *
 * ── ORDERING ────────────────────────────────────────────────────────────────
 * CREATE the new index first, then DROP the old one. In that order there is no
 * instant where a duplicate could be written: the new guarantee is live before
 * the old one goes away. The reverse order leaves a window with no
 * one-invoice-per-milestone rule at all.
 *
 * SAFETY: refuses a non-local Mongo unless the operator sets BOTH ALLOW_REMOTE=1
 * and --apply. Dry-run by default.
 *
 * Usage:
 *   node scripts/migrate-invoice-payment-index.js                        # local dry-run
 *   node scripts/migrate-invoice-payment-index.js --apply                # local apply
 *   ALLOW_REMOTE=1 node scripts/migrate-invoice-payment-index.js --apply # PROD (both gates)
 */
require("dotenv").config();
const mongoose = require("mongoose");
const VenueInvoice = require("../models/VenueInvoice");

const TAG = "migrate-invoice-payment-index";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);
const APPLY = process.argv.includes("--apply");
const ALLOW_REMOTE = process.env.ALLOW_REMOTE === "1";

const OLD_NAME = "enquiry_1_forMilestoneId_1";
const NEW_NAME = "enquiry_1_forMilestoneId_1_forPaymentId_1";
const NEW_KEY = { enquiry: 1, forMilestoneId: 1, forPaymentId: 1 };
const NEW_OPTS = { unique: true, partialFilterExpression: { enquiry: { $type: "objectId" } }, name: NEW_NAME };

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

  const coll = VenueInvoice.collection;
  const before = await coll.indexes();
  const hasOld = before.some((i) => i.name === OLD_NAME);
  const hasNew = before.some((i) => i.name === NEW_NAME);

  console.log(`[${TAG}] indexes on ${coll.collectionName}:`);
  before.forEach((i) => console.log(`[${TAG}]   ${i.name}${i.unique ? "  (unique)" : ""}`));
  console.log(`[${TAG}]`);
  console.log(`[${TAG}] old two-key index present ... ${hasOld ? "YES — must be dropped" : "no"}`);
  console.log(`[${TAG}] new three-key index present . ${hasNew ? "yes" : "NO — must be created"}`);

  // ── would the new index even build? ──
  // Reported BEFORE anything is dropped. A duplicate here means two documents
  // already share {enquiry, forMilestoneId, forPaymentId}, which the old index
  // should have prevented — so it is a data problem to investigate, not a
  // migration to force.
  const dupes = await coll
    .aggregate([
      { $match: { enquiry: { $type: "objectId" } } },
      { $group: { _id: { e: "$enquiry", m: "$forMilestoneId", p: "$forPaymentId" }, n: { $sum: 1 }, ids: { $push: "$_id" } } },
      { $match: { n: { $gt: 1 } } },
    ])
    .toArray();
  console.log(`[${TAG}] documents that would collide ... ${dupes.length}`);
  for (const d of dupes) {
    console.log(`[${TAG}]   ✗ ${d.n} invoices share ${JSON.stringify(d._id)} → ${d.ids.join(", ")}`);
  }
  const leadInvoices = await coll.countDocuments({ enquiry: { $type: "objectId" } });
  console.log(`[${TAG}] lead invoices in scope ....... ${leadInvoices}\n`);

  if (dupes.length) {
    console.log(`[${TAG}] ✗ REFUSING: the new index would not build. Investigate the duplicates above.`);
    await mongoose.disconnect();
    process.exitCode = 1;
    return;
  }

  if (!APPLY) {
    console.log(`[${TAG}] DRY-RUN — would ${hasNew ? "keep" : "CREATE"} ${NEW_NAME}, then ${hasOld ? "DROP" : "skip"} ${OLD_NAME}.`);
    console.log(`[${TAG}] Nothing written. Re-run with --apply.`);
    await mongoose.disconnect();
    return;
  }

  // CREATE FIRST. The new guarantee is live before the old one is removed, so
  // there is no window in which a duplicate could be written.
  if (!hasNew) {
    await coll.createIndex(NEW_KEY, NEW_OPTS);
    console.log(`[${TAG}] ✓ created ${NEW_NAME}`);
  } else {
    console.log(`[${TAG}] · ${NEW_NAME} already present`);
  }
  if (hasOld) {
    await coll.dropIndex(OLD_NAME);
    console.log(`[${TAG}] ✓ dropped ${OLD_NAME}`);
  } else {
    console.log(`[${TAG}] · ${OLD_NAME} already gone`);
  }

  const after = await coll.indexes();
  console.log(`\n[${TAG}] indexes now:`);
  after.forEach((i) => console.log(`[${TAG}]   ${i.name}${i.unique ? "  (unique)" : ""}`));
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error(`[${TAG}] FAILED: ${err.message}`);
  try { await mongoose.disconnect(); } catch (e) { /* already down */ }
  process.exitCode = 1;
});
