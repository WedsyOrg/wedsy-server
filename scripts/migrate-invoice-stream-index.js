/**
 * scripts/migrate-invoice-stream-index.js
 *
 * GST-FIRST (wizard2) allows ONE PAYMENT to carry TWO invoices — a tax
 * invoice for what landed on the taxed stream and an ordinary invoice for
 * the rest — so `stream` joins the uniqueness key:
 *
 *   OLD  { enquiry, forMilestoneId, forPaymentId }          unique, partial
 *   NEW  { enquiry, forMilestoneId, forPaymentId, stream }  unique, partial
 *
 * ── THIS IS A DROP, NOT AN ADD ──────────────────────────────────────────────
 * Both indexes can physically coexist, and that is the trap (the S6 migration
 * hit the same shape): under the OLD key the two halves of one payment both
 * read as {e, null, p} and COLLIDE — exactly the pair GST-first needs to
 * allow. Leaving the old index does not soften the behaviour, it silently
 * forbids it: the second half of every split would 409.
 *
 * ── IT CANNOT LOSE A GUARANTEE ──────────────────────────────────────────────
 * Adding a fourth key only ever splits index entries apart, never merges
 * them. Every pre-existing invoice has no `stream`, indexes as {e,m,p,null},
 * and keys that were unique stay unique. Duplicates are checked before
 * anything is dropped, so a data problem is reported, never forced past.
 *
 * ── ORDERING ────────────────────────────────────────────────────────────────
 * CREATE the new index first, then DROP the old one — no instant without a
 * uniqueness rule.
 *
 * SAFETY: refuses a non-local Mongo unless BOTH ALLOW_REMOTE=1 and --apply.
 * Dry-run by default. Require-able: tests call migrate({ apply }) directly so
 * this cannot rot unexercised while the shapes it writes drift.
 *
 * Usage:
 *   node scripts/migrate-invoice-stream-index.js                        # local dry-run
 *   node scripts/migrate-invoice-stream-index.js --apply                # local apply
 *   ALLOW_REMOTE=1 node scripts/migrate-invoice-stream-index.js --apply # PROD (both gates)
 */
require("dotenv").config();
const mongoose = require("mongoose");
const VenueInvoice = require("../models/VenueInvoice");

const TAG = "migrate-invoice-stream-index";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);

const OLD_NAME = "enquiry_1_forMilestoneId_1_forPaymentId_1";
const NEW_NAME = "enquiry_1_forMilestoneId_1_forPaymentId_1_stream_1";
const NEW_KEY = { enquiry: 1, forMilestoneId: 1, forPaymentId: 1, stream: 1 };
const NEW_OPTS = { unique: true, partialFilterExpression: { enquiry: { $type: "objectId" } }, name: NEW_NAME };

function assertMongoTarget({ apply, allowRemote }) {
  const url = process.env.DATABASE_URL || "";
  let host;
  try {
    host = new URL(url).hostname;
  } catch (e) {
    throw new Error(`Cannot parse DATABASE_URL to verify host: ${e.message}`);
  }
  const isLocal = LOCAL_HOSTS.has(host);
  console.log(`[${TAG}] TARGET ${host} (${isLocal ? "local" : "REMOTE"}) · MODE ${apply ? "APPLY" : "DRY-RUN"}`);
  if (isLocal) return host;
  if (!allowRemote || !apply) {
    throw new Error(
      `Refusing to run: DATABASE_URL host "${host}" is REMOTE. ` +
        `The guarded production path requires BOTH ALLOW_REMOTE=1 and --apply.`
    );
  }
  console.log(`[${TAG}] ⚠  REMOTE APPLY authorized — writing to ${host}`);
  return host;
}

/** The migration, callable from tests. Assumes mongoose is CONNECTED when
 *  `connected: true`; otherwise connects/disconnects itself. */
async function migrate({ apply = false, allowRemote = process.env.ALLOW_REMOTE === "1", connected = false } = {}) {
  if (!connected) {
    assertMongoTarget({ apply, allowRemote });
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 8000 });
  }
  const coll = VenueInvoice.collection;
  const before = await coll.indexes();
  const hasOld = before.some((i) => i.name === OLD_NAME);
  const hasNew = before.some((i) => i.name === NEW_NAME);
  console.log(`[${TAG}] old three-key index ... ${hasOld ? "YES — must be dropped" : "no"}`);
  console.log(`[${TAG}] new four-key index .... ${hasNew ? "yes" : "NO — must be created"}`);

  const dupes = await coll
    .aggregate([
      { $match: { enquiry: { $type: "objectId" } } },
      { $group: { _id: { e: "$enquiry", m: "$forMilestoneId", p: "$forPaymentId", s: "$stream" }, n: { $sum: 1 }, ids: { $push: "$_id" } } },
      { $match: { n: { $gt: 1 } } },
    ])
    .toArray();
  console.log(`[${TAG}] documents that would collide ... ${dupes.length}`);
  for (const d of dupes) console.log(`[${TAG}]   ✗ ${d.n} share ${JSON.stringify(d._id)} → ${d.ids.join(", ")}`);
  if (dupes.length) {
    if (!connected) await mongoose.disconnect();
    throw new Error("the new index would not build — investigate the duplicates above");
  }

  if (!apply) {
    console.log(`[${TAG}] DRY-RUN — would ${hasNew ? "keep" : "CREATE"} ${NEW_NAME}, then ${hasOld ? "DROP" : "skip"} ${OLD_NAME}. Nothing written.`);
    if (!connected) await mongoose.disconnect();
    return { applied: false, hasOld, hasNew };
  }

  // CREATE FIRST — the new guarantee is live before the old one goes away.
  if (!hasNew) {
    await coll.createIndex(NEW_KEY, NEW_OPTS);
    console.log(`[${TAG}] ✓ created ${NEW_NAME}`);
  }
  if (hasOld) {
    await coll.dropIndex(OLD_NAME);
    console.log(`[${TAG}] ✓ dropped ${OLD_NAME}`);
  }
  const after = await coll.indexes();
  if (!connected) await mongoose.disconnect();
  return { applied: true, indexes: after.map((i) => i.name) };
}

module.exports = { migrate, OLD_NAME, NEW_NAME };

if (require.main === module) {
  migrate({ apply: process.argv.includes("--apply") }).catch(async (err) => {
    console.error(`[${TAG}] FAILED: ${err.message}`);
    try { await mongoose.disconnect(); } catch (e) { /* already down */ }
    process.exitCode = 1;
  });
}
