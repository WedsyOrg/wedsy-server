/* Decor.createdAt / updatedAt — ISO-8601 STRINGS → real BSON Dates.
 *
 * THE PROBLEM. 798 of 800 décor products store their timestamps as STRINGS, not
 * dates — a legacy import that predates { timestamps: true } on the schema.
 * MongoDB compares by TYPE BRACKET before value, so today:
 *
 *   { createdAt: { $gte: ISODate(2020), $lte: ISODate(2030) } }  → matches   2 of 800
 *   { createdAt: { $gte: "2020-01-01", $lte: "2030-01-01" } }    → matches 798 of 800
 *
 * Neither matches everything, and NEITHER ERRORS. Any "products uploaded between
 * X and Y" filter written the obvious way silently returns two rows.
 *
 * It also means ?sort=Newest-First is ALREADY WRONG: date-typed rows outrank
 * every string-typed row regardless of their actual value.
 *
 * WHAT THIS DOES. Converts each string to ITS OWN date. 2023-11-29 stays
 * 2023-11-29. It does NOT stamp rows with today — that would be writing false
 * data, and it would make the sort worse rather than better, because all 798
 * legacy products would then claim to be the newest things in the catalogue.
 *
 * SAFETY
 *   · DRY RUN BY DEFAULT. --confirm is required to write anything.
 *   · $type:"string" guarded, so it is idempotent — a second run finds nothing
 *     left to do and says so. Rows already stored as dates are never touched.
 *   · Every value is parsed and re-serialised BEFORE any write. If even one
 *     string does not round-trip to exactly the same ISO text, the script
 *     ABORTS and converts nothing. It does not guess at a format.
 *   · Writes per document with its own value — never a bulk $set of one date.
 *
 * RUN IT ON THE EC2 BOX, against prod. Not from a laptop, not from a dev shell:
 * the connection string on a local machine points at the dev database, and a
 * migration that silently rewrites the wrong database is worse than one that
 * fails.
 *
 *   ssh <ec2>
 *   cd /path/to/wedsy-server-crm
 *   node scripts/migrate-decor-timestamps-to-date.js                # DRY RUN
 *   node scripts/migrate-decor-timestamps-to-date.js --confirm      # convert
 *   node scripts/migrate-decor-timestamps-to-date.js                # verify (0 left)
 */
require("dotenv").config();
const mongoose = require("mongoose");

const CONFIRM = process.argv.includes("--confirm");
const FIELDS = ["createdAt", "updatedAt"];
const SAMPLE = 5;

// Strict ISO-8601 UTC, exactly the form all 798 were reported in. Anything else
// is a deviation and stops the run.
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const line = (s = "") => console.log(s);

(async () => {
  const uri = process.env.DATABASE_URL;
  if (!uri) {
    console.error("DATABASE_URL not set — refusing to run.");
    process.exit(1);
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  const col = mongoose.connection.db.collection("decors");

  const target = `${mongoose.connection.host}/${mongoose.connection.name}`;
  line(`Target      : ${target}`);
  line(`Mode        : ${CONFIRM ? "CONVERT (--confirm)" : "DRY RUN (read-only)"}`);
  line("");

  // ── 1. census ─────────────────────────────────────────────────────────────
  const total = await col.countDocuments({});
  line(`decors documents: ${total}`);
  const counts = {};
  for (const f of FIELDS) {
    counts[f] = {
      date: await col.countDocuments({ [f]: { $type: "date" } }),
      string: await col.countDocuments({ [f]: { $type: "string" } }),
      missing: await col.countDocuments({ [f]: { $exists: false } }),
    };
    const c = counts[f];
    line(`  ${f.padEnd(10)} date:${String(c.date).padStart(4)}  string:${String(c.string).padStart(4)}  missing:${String(c.missing).padStart(4)}`);
  }
  line("");

  const workTotal = FIELDS.reduce((n, f) => n + counts[f].string, 0);
  if (workTotal === 0) {
    line("Nothing to convert — every timestamp is already a real Date.");
    line(CONFIRM ? "No writes performed." : "");
    await mongoose.disconnect();
    return;
  }

  // ── 2. VERIFY EVERY VALUE BEFORE TOUCHING ANYTHING ────────────────────────
  // Parse-and-round-trip each string. A value that does not come back byte-for
  // byte is a format we were not told about, and the run stops.
  const deviations = [];
  const samples = [];
  for (const f of FIELDS) {
    const cursor = col.find({ [f]: { $type: "string" } }, { projection: { [f]: 1, "productInfo.id": 1, name: 1 } });
    while (await cursor.hasNext()) {
      const doc = await cursor.next();
      const raw = doc[f];
      const code = (doc.productInfo && doc.productInfo.id) || String(doc._id);
      if (!ISO_UTC.test(raw)) {
        deviations.push({ code, field: f, raw, why: "not strict ISO-8601 UTC" });
        continue;
      }
      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) {
        deviations.push({ code, field: f, raw, why: "Date() could not parse it" });
        continue;
      }
      if (parsed.toISOString() !== raw) {
        deviations.push({ code, field: f, raw, why: `round-trips to ${parsed.toISOString()}` });
        continue;
      }
      if (samples.length < SAMPLE) samples.push({ code, field: f, raw, parsed });
    }
  }

  line(`Verified ${workTotal} string value(s); deviations: ${deviations.length}`);
  if (deviations.length) {
    line("");
    line("ABORTING — these values are not a format this script was told to expect.");
    line("Nothing has been written. Decide what they should become before re-running:");
    for (const d of deviations.slice(0, 20)) {
      line(`  ${String(d.code).padEnd(10)} ${d.field.padEnd(10)} ${JSON.stringify(d.raw)}  — ${d.why}`);
    }
    if (deviations.length > 20) line(`  … and ${deviations.length - 20} more`);
    await mongoose.disconnect();
    process.exit(1);
  }

  line("");
  line("Sample of what would change (each keeps its OWN date):");
  for (const s of samples) {
    line(`  ${String(s.code).padEnd(10)} ${s.field.padEnd(10)} "${s.raw}"  →  ISODate("${s.parsed.toISOString()}")`);
  }

  // What the fix buys, measured on the real data rather than asserted.
  const lo = new Date("2000-01-01");
  const hi = new Date("2100-01-01");
  const beforeRange = await col.countDocuments({ createdAt: { $gte: lo, $lte: hi } });
  line("");
  line("Effect on a date-range query, {createdAt: 2000..2100}:");
  line(`  now            : matches ${beforeRange} of ${total}`);
  line(`  after converting: would match ${beforeRange + counts.createdAt.string} of ${total}`);

  if (!CONFIRM) {
    line("");
    line("DRY RUN — nothing was written.");
    line("Re-run with --confirm on the EC2 box to convert.");
    await mongoose.disconnect();
    return;
  }

  // ── 3. convert, one document at a time, each with its own value ───────────
  line("");
  line("Converting…");
  let converted = 0;
  for (const f of FIELDS) {
    let n = 0;
    const cursor = col.find({ [f]: { $type: "string" } }, { projection: { [f]: 1 } });
    while (await cursor.hasNext()) {
      const doc = await cursor.next();
      // Re-check the guard per document: another process could have converted
      // this row since the census.
      if (typeof doc[f] !== "string") continue;
      const parsed = new Date(doc[f]);
      if (Number.isNaN(parsed.getTime())) continue; // unreachable — verified above
      // timestamps:true would otherwise bump updatedAt on write; this is a raw
      // driver call, so the schema's hooks do not run and the value is exact.
      await col.updateOne({ _id: doc._id, [f]: { $type: "string" } }, { $set: { [f]: parsed } });
      n += 1;
    }
    converted += n;
    line(`  ${f}: converted ${n}`);
  }

  // ── 4. fresh count, so the run reports its own result ─────────────────────
  line("");
  line("After:");
  for (const f of FIELDS) {
    const date = await col.countDocuments({ [f]: { $type: "date" } });
    const string = await col.countDocuments({ [f]: { $type: "string" } });
    line(`  ${f.padEnd(10)} date:${String(date).padStart(4)}  string:${String(string).padStart(4)}`);
  }
  const afterRange = await col.countDocuments({ createdAt: { $gte: lo, $lte: hi } });
  line(`  date-range query now matches ${afterRange} of ${total}`);
  line("");
  line(`Done — ${converted} value(s) converted. Re-run without --confirm to verify 0 strings remain.`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error("FAILED:", e && e.message);
  process.exit(1);
});
