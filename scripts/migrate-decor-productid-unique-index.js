/* Decor.productInfo.id — PARTIAL UNIQUE INDEX (the July P0 fix).
 *
 * Deliberately a migration, NOT an autoIndex-at-boot declaration: building a
 * unique index against the live collection should be an act, not a side effect
 * of a pm2 restart. models/Decor.js documents the spec and explains why it is
 * not declared there.
 *
 *   key     { "productInfo.id": 1 }
 *   unique  true
 *   partial { "productInfo.id": { $type: "string", $gt: "" } }
 *
 * PARTIAL so blank/absent codes are exempt — a plain unique index would make
 * every future "" collide with the first one.
 *
 * Dry-run by default (pre-check only); --confirm creates the index.
 * Safe to re-run: an existing identical index is reported and left alone.
 *
 *   node scripts/migrate-decor-productid-unique-index.js            # pre-check
 *   node scripts/migrate-decor-productid-unique-index.js --confirm  # create
 *   node scripts/migrate-decor-productid-unique-index.js --drop     # remove it
 */
require("dotenv").config();
const mongoose = require("mongoose");

const CONFIRM = process.argv.includes("--confirm");
const DROP = process.argv.includes("--drop");

const INDEX_NAME = "productInfo_id_unique";
const INDEX_KEY = { "productInfo.id": 1 };
const INDEX_OPTS = {
  unique: true,
  partialFilterExpression: { "productInfo.id": { $type: "string", $gt: "" } },
  name: INDEX_NAME,
};

const printIndexes = async (col, label) => {
  const ix = await col.indexes();
  console.log(`\n${label}`);
  for (const i of ix) {
    const bits = [`key=${JSON.stringify(i.key)}`];
    if (i.unique) bits.push("UNIQUE");
    if (i.partialFilterExpression) bits.push(`partial=${JSON.stringify(i.partialFilterExpression)}`);
    console.log(`  ${i.name.padEnd(28)} ${bits.join("  ")}`);
  }
};

(async () => {
  const uri = process.env.DATABASE_URL;
  if (!uri) {
    console.error("DATABASE_URL not set");
    process.exit(1);
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  const col = mongoose.connection.db.collection("decors");
  console.log(`Target: ${uri.replace(/\/\/[^@]*@/, "//<creds>@").slice(0, 120)}`);

  if (DROP) {
    const existing = (await col.indexes()).find((i) => i.name === INDEX_NAME);
    if (!existing) {
      console.log(`\n${INDEX_NAME} is not present — nothing to drop.`);
    } else if (!CONFIRM) {
      console.log(`\nDRY RUN — would drop ${INDEX_NAME}. Re-run with --drop --confirm.`);
    } else {
      await col.dropIndex(INDEX_NAME);
      console.log(`\nDropped ${INDEX_NAME}.`);
    }
    await printIndexes(col, "Indexes now:");
    await mongoose.disconnect();
    process.exit(0);
  }

  // ── PRE-CHECK ─────────────────────────────────────────────────────────────
  const total = await col.countDocuments({});
  const blanks = await col.countDocuments({
    $or: [
      { "productInfo.id": { $exists: false } },
      { "productInfo.id": null },
      { "productInfo.id": "" },
    ],
  });
  const dupes = await col
    .aggregate([
      { $match: { "productInfo.id": { $nin: [null, ""] } } },
      { $group: { _id: "$productInfo.id", n: { $sum: 1 }, ids: { $push: "$_id" } } },
      { $match: { n: { $gt: 1 } } },
      { $sort: { n: -1 } },
    ])
    .toArray();
  const extra = dupes.reduce((s, d) => s + (d.n - 1), 0);

  console.log("\nPRE-CHECK");
  console.log(`  total décor documents        ${total}`);
  console.log(`  blank / absent product code  ${blanks}   (exempt — the index is PARTIAL)`);
  console.log(`  duplicate codes              ${dupes.length}`);
  console.log(`  docs that would have to move ${extra}`);
  for (const d of dupes.slice(0, 20)) {
    console.log(`    ⚠ ${String(d._id).padEnd(14)} x${d.n}   ${d.ids.slice(0, 4).map(String).join(", ")}`);
  }
  if (dupes.length > 20) console.log(`    … +${dupes.length - 20} more`);

  await printIndexes(col, "Indexes before:");

  const already = (await col.indexes()).find((i) => i.name === INDEX_NAME);
  if (already) {
    console.log(`\n${INDEX_NAME} already exists — nothing to do (safe re-run).`);
    await mongoose.disconnect();
    process.exit(0);
  }

  if (dupes.length) {
    console.error(
      `\nREFUSING TO BUILD — ${dupes.length} duplicate code(s) present. ` +
        `Resolve them first; this script will not force the index or mutate data.`
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  if (!CONFIRM) {
    console.log(`\nDRY RUN — pre-check is clean. Re-run with --confirm to create ${INDEX_NAME}.`);
    await mongoose.disconnect();
    process.exit(0);
  }

  console.log(`\nCreating ${INDEX_NAME} …`);
  await col.createIndex(INDEX_KEY, INDEX_OPTS);
  console.log("Created.");

  await printIndexes(col, "Indexes after:");
  await mongoose.disconnect();
  process.exit(0);
})().catch(async (e) => {
  console.error("FAILED:", e.message);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
