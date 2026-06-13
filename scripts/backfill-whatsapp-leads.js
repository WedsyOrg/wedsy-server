/* MB5 Slice 1 — Bug A backfill.
 *
 * Patches existing source-whatsapp Enquiry docs that are missing the
 * create-path fields a manually created lead always has (stage and the
 * boolean flags). The board renders only configured stage columns, so a
 * lead with a missing/empty stage silently disappears from it.
 *
 * Idempotent: only touches docs where a field is missing/null/empty; a
 * second run finds nothing to do. READ-ONLY without --confirm.
 *
 * Usage:
 *   node scripts/backfill-whatsapp-leads.js            # dry-run: report counts only
 *   node scripts/backfill-whatsapp-leads.js --confirm  # apply the patch
 */
require("dotenv").config();
const mongoose = require("mongoose");

const CONFIRM = process.argv.includes("--confirm");

// Field → { match: docs needing the patch, set: value to write }
const PATCHES = {
  stage: {
    match: { $or: [{ stage: { $exists: false } }, { stage: null }, { stage: "" }] },
    set: "new",
  },
  verified: {
    match: { $or: [{ verified: { $exists: false } }, { verified: null }] },
    set: false,
  },
  isInterested: {
    match: { $or: [{ isInterested: { $exists: false } }, { isInterested: null }] },
    set: false,
  },
  isLost: {
    match: { $or: [{ isLost: { $exists: false } }, { isLost: null }] },
    set: false,
  },
  additionalInfo: {
    match: { $or: [{ additionalInfo: { $exists: false } }, { additionalInfo: null }] },
    set: {},
  },
  lostStatus: {
    match: { $or: [{ lostStatus: { $exists: false } }, { lostStatus: null }] },
    set: "none",
  },
};

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL missing — run from the repo root with .env present.");
    process.exit(1);
  }
  await mongoose.connect(process.env.DATABASE_URL);
  const Enquiry = require("../models/Enquiry");

  const base = { source: "whatsapp" };
  const total = await Enquiry.countDocuments(base);
  console.log(`source-whatsapp leads: ${total}`);

  console.log("\n── BEFORE ──");
  const before = {};
  for (const [field, p] of Object.entries(PATCHES)) {
    before[field] = await Enquiry.countDocuments({ ...base, ...p.match });
    console.log(`missing ${field}: ${before[field]}`);
  }
  const anyToPatch = Object.values(before).some((n) => n > 0);

  if (!anyToPatch) {
    console.log("\nNothing to patch — all source-whatsapp leads already have the create-path fields.");
    await mongoose.disconnect();
    return;
  }

  if (!CONFIRM) {
    console.log("\nDRY RUN — no writes performed. Re-run with --confirm to apply.");
    await mongoose.disconnect();
    process.exit(2);
  }

  console.log("\n── APPLYING ──");
  for (const [field, p] of Object.entries(PATCHES)) {
    if (before[field] === 0) continue;
    const r = await Enquiry.updateMany({ ...base, ...p.match }, { $set: { [field]: p.set } });
    console.log(`patched ${field}: ${r.modifiedCount}`);
  }

  console.log("\n── AFTER ──");
  for (const [field, p] of Object.entries(PATCHES)) {
    const n = await Enquiry.countDocuments({ ...base, ...p.match });
    console.log(`missing ${field}: ${n}`);
  }

  await mongoose.disconnect();
  console.log("\nDone.");
})();
