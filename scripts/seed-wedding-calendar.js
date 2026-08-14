/**
 * scripts/seed-wedding-calendar.js — 2026-27 wedding calendar seed.
 *
 * Loads the muhurat dates, blackout seasons and public holidays for the
 * 2026-27 season. EVERYTHING lands with verified:false, because that is the
 * truth about it: the muhurat list is an AI-sourced summary that says itself to
 * confirm against a regional panchang, and holiday dates get re-notified. A
 * human flips rows to verified in the OS settings UI as they check them.
 *
 * SAFETY (house convention): dry-run by default; a remote target needs BOTH
 * ALLOW_REMOTE=1 and --apply; --apply writes a backup of every row it would
 * touch to scripts/backups/ BEFORE writing anything, so an apply is reversible
 * from the artifact alone. Idempotent throughout — re-running updates rather
 * than duplicating (upsert on each model's unique key).
 *
 *   node scripts/seed-wedding-calendar.js                          # local dry-run (default)
 *   node scripts/seed-wedding-calendar.js --apply                  # local backup + write
 *   ALLOW_REMOTE=1 node scripts/seed-wedding-calendar.js --apply   # PROD (both gates)
 *
 * ── DATA PROVENANCE, and the three conflicts it carries ──────────────────────
 *
 * 1. DIWALI 2026 IS TWO ROWS, NOT A CONTRADICTION. The national gazette lists
 *    8 Nov; Karnataka's own DPAR notification lists 8 Nov as Naraka Chaturdashi
 *    and 10 Nov as Balipadyami (Deepavali). Both are true — it is a multi-day
 *    festival and the two jurisdictions name different days of it. For a
 *    Bangalore venue the Karnataka dates are the ones whose leave guests
 *    actually get. Seeded with their correct scopes; nothing is picked.
 *
 * 2. HOLI 2026 is cited as both 3 and 4 March. The gazetted national list says
 *    4 March, so that is what is seeded — with the disagreement written into
 *    the row's notes rather than dropped.
 *
 * 3. MARCH 2027, THE ONE THAT NEEDS A HUMAN. The muhurat source lists 21 and
 *    22 March as South Indian auspicious dates. Holashtak (a NORTH-only
 *    blackout) runs 14-22 March, and Holi 2027 falls on 22 March. The
 *    tradition axis resolves the first half cleanly — a north blackout does not
 *    touch a south date — but a wedding muhurat landing on Holi itself is the
 *    kind of thing only a panchang settles. Both rows are seeded verified:false
 *    with the conflict in their notes, and utils/weddingCalendar.findConflicts
 *    surfaces it in the settings UI as "needs review".
 *
 * KARNATAKA 2027 IS DELIBERATELY ABSENT. The state publishes in late Nov/Dec of
 * the preceding year, so it does not exist yet. Seeding a guess would be worse
 * than the gap; the settings UI says "not yet notified" instead of implying the
 * state has no holidays.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const AuspiciousDate = require("../models/AuspiciousDate");
const BlackoutPeriod = require("../models/BlackoutPeriod");
const PublicHoliday = require("../models/PublicHoliday");
const { toDayStart, dayParts } = require("../utils/auspiciousDates");

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);
const APPLY = process.argv.includes("--apply");
const ALLOW_REMOTE = process.env.ALLOW_REMOTE === "1";
const BACKUP_DIR = path.join(__dirname, "backups");
const TAG = "[seed-wedding-calendar]";

const N = "north_indian";
const S = "south_indian";
const BOTH = [N, S];
// The broader-list dates: cited as auspicious without saying whose calendar.
// Empty traditions = unspecified, which applies to everyone (see
// utils/weddingTraditions) — the honest reading of "a source lists this date".
const UNSPEC = [];

const SRC = "Seeded from the 2026-27 muhurat summary — unverified, confirm against a regional panchang.";

// ── muhurat dates ───────────────────────────────────────────────────────────
// One entry per calendar date; traditions MERGE onto the single row for that
// date (the model is unique on {date, region}, and every row here is national).
const MUHURAT = {
  // NOV 2026 — north 21/24/25/26 · south 2/3/4/6/7/8 · broader list 1/16/18/20
  "2026-11-01": UNSPEC, "2026-11-02": [S], "2026-11-03": [S], "2026-11-04": [S],
  "2026-11-06": [S], "2026-11-07": [S], "2026-11-08": [S],
  "2026-11-16": UNSPEC, "2026-11-18": UNSPEC, "2026-11-20": UNSPEC,
  "2026-11-21": [N], "2026-11-24": [N], "2026-11-25": [N], "2026-11-26": [N],

  // DEC 2026 — north 1/2/3/4/11/12/13 · south 1/2/3/4/5/6/10/13
  "2026-12-01": BOTH, "2026-12-02": BOTH, "2026-12-03": BOTH, "2026-12-04": BOTH,
  "2026-12-05": [S], "2026-12-06": [S], "2026-12-10": [S],
  "2026-12-11": [N], "2026-12-12": [N], "2026-12-13": BOTH,

  // JAN 2027 — both, post-Sankranti Uttarayana opening. 15 also cited.
  "2027-01-15": UNSPEC,
  "2027-01-18": BOTH, "2027-01-19": BOTH, "2027-01-20": BOTH,
  "2027-01-24": BOTH, "2027-01-25": BOTH, "2027-01-26": BOTH, "2027-01-27": BOTH,
  "2027-01-28": BOTH, "2027-01-30": BOTH, "2027-01-31": BOTH,

  // FEB 2027 — both. 20 also cited.
  "2027-02-02": BOTH, "2027-02-03": BOTH, "2027-02-09": BOTH, "2027-02-10": BOTH,
  "2027-02-11": BOTH, "2027-02-12": BOTH, "2027-02-14": BOTH, "2027-02-15": BOTH,
  "2027-02-20": UNSPEC,
  "2027-02-21": BOTH, "2027-02-22": BOTH, "2027-02-25": BOTH, "2027-02-26": BOTH,
  "2027-02-27": BOTH, "2027-02-28": BOTH,

  // MAR 2027 — south full list; north the same MINUS 14-22 (Holashtak).
  "2027-03-02": BOTH, "2027-03-03": BOTH, "2027-03-05": BOTH, "2027-03-06": BOTH,
  "2027-03-07": BOTH, "2027-03-09": BOTH, "2027-03-10": BOTH, "2027-03-11": BOTH,
  "2027-03-14": [S], "2027-03-15": [S], "2027-03-21": [S], "2027-03-22": [S],
  "2027-03-25": BOTH, "2027-03-26": BOTH, "2027-03-27": BOTH, "2027-03-28": BOTH,

  // APR 2027 — both 18/19/21/23-28. Broader list 7/10/12/16.
  "2027-04-07": UNSPEC, "2027-04-10": UNSPEC, "2027-04-12": UNSPEC, "2027-04-16": UNSPEC,
  "2027-04-18": BOTH, "2027-04-19": BOTH, "2027-04-21": BOTH, "2027-04-23": BOTH,
  "2027-04-24": BOTH, "2027-04-25": BOTH, "2027-04-26": BOTH, "2027-04-27": BOTH,
  "2027-04-28": BOTH,

  // MAY 2027 — both
  "2027-05-04": BOTH, "2027-05-07": BOTH, "2027-05-08": BOTH, "2027-05-09": BOTH,
  "2027-05-13": BOTH, "2027-05-14": BOTH, "2027-05-15": BOTH, "2027-05-16": BOTH,
  "2027-05-17": BOTH, "2027-05-18": BOTH, "2027-05-19": BOTH, "2027-05-20": BOTH,
  "2027-05-21": BOTH, "2027-05-22": BOTH, "2027-05-23": BOTH, "2027-05-24": BOTH,
  "2027-05-25": BOTH, "2027-05-30": BOTH, "2027-05-31": BOTH,

  // JUN 2027 — both
  "2027-06-01": BOTH, "2027-06-05": BOTH, "2027-06-09": BOTH, "2027-06-10": BOTH,
  "2027-06-11": BOTH, "2027-06-12": BOTH, "2027-06-13": BOTH, "2027-06-15": BOTH,
  "2027-06-16": BOTH, "2027-06-17": BOTH, "2027-06-19": BOTH, "2027-06-20": BOTH,
  "2027-06-21": BOTH, "2027-06-26": BOTH, "2027-06-27": BOTH, "2027-06-28": BOTH,
};

// Per-date notes, for the rows that carry a known problem.
const MUHURAT_NOTES = {
  "2027-03-21": `${SRC} CONFLICT: inside Holashtak (14-22 Mar, north-only) — the tradition axis separates them, but confirm the South Indian listing against a panchang.`,
  "2027-03-22": `${SRC} CONFLICT: this is Holi 2027 AND the last day of Holashtak (north-only). A muhurat on Holi itself needs a human ruling.`,
};

// ── blackout seasons ────────────────────────────────────────────────────────
// Inclusive both ends. The north/south split is real: Kharmas closes the
// northern season on 14 Dec, Dhanurmasam the southern on the 15th, and both
// reopen at Makar Sankranti.
const BLACKOUTS = [
  {
    name: "Chaturmas",
    startDate: "2027-07-14",
    endDate: "2027-10-31",
    traditions: [],
    notes:
      "Almost no Hindu weddings take place from mid-July to the end of October. Exact Ekadashi boundaries vary by panchang — confirm before relying on the edges.",
  },
  {
    name: "Kharmas",
    startDate: "2026-12-14",
    endDate: "2027-01-14",
    traditions: [N],
    notes: "The northern season closes on 14 December and reopens at Makar Sankranti.",
  },
  {
    name: "Dhanurmasam",
    startDate: "2026-12-15",
    endDate: "2027-01-14",
    traditions: [S],
    notes: "The southern equivalent of Kharmas — closes 15 December, reopens at Makar Sankranti.",
  },
  {
    name: "Holashtak",
    startDate: "2027-03-14",
    endDate: "2027-03-22",
    traditions: [N],
    notes: "The eight days before Holi. North Indian only; South Indian weddings continue through it.",
  },
];

// ── public holidays ─────────────────────────────────────────────────────────
const GAZ = "Government of India gazetted list — unverified, confirm against the notification.";
const KA =
  "Karnataka DPAR notification No. DPAR 16 HHL 2025 dated 17 Nov 2025 — unverified, confirm against the notification.";

const HOLIDAYS = [
  // ── NATIONAL 2026 ──
  { date: "2026-01-26", name: "Republic Day", type: "national", notes: GAZ },
  { date: "2026-03-04", name: "Holi", type: "national", notes: `${GAZ} CONFLICT: sources cite both 3 and 4 March; the gazetted date (4th) is seeded.` },
  { date: "2026-03-21", name: "Id-ul-Fitr", type: "national", notes: GAZ },
  { date: "2026-03-26", name: "Ram Navami", type: "national", notes: GAZ },
  { date: "2026-03-31", name: "Mahavir Jayanti", type: "national", notes: GAZ },
  { date: "2026-04-03", name: "Good Friday", type: "national", notes: GAZ },
  { date: "2026-05-01", name: "Buddha Purnima", type: "national", notes: GAZ },
  { date: "2026-05-27", name: "Bakrid", type: "national", notes: `${GAZ} Karnataka's own list gives 28 May — both are seeded with their scopes.` },
  // Independence Day and Gandhi Jayanti are fixed-date national holidays and
  // were missing from the supplied 2026 list while present in 2027 and in the
  // Karnataka list — a clerical gap, not a real absence. Added, flagged.
  { date: "2026-08-15", name: "Independence Day", type: "national", notes: `${GAZ} Added: absent from the supplied 2026 list but a fixed-date national holiday.` },
  { date: "2026-08-26", name: "Milad-un-Nabi", type: "national", notes: GAZ },
  { date: "2026-09-04", name: "Janmashtami", type: "national", notes: GAZ },
  { date: "2026-10-02", name: "Gandhi Jayanti", type: "national", notes: `${GAZ} Added: absent from the supplied 2026 list but a fixed-date national holiday.` },
  { date: "2026-11-08", name: "Diwali", type: "national", notes: `${GAZ} Karnataka names 8 Nov Naraka Chaturdashi and 10 Nov Balipadyami — different days of one festival, both seeded.` },
  { date: "2026-12-25", name: "Christmas", type: "national", notes: GAZ },

  // ── KARNATAKA 2026 (regional) ──
  { date: "2026-01-01", name: "New Year's Day", type: "regional", region: "Karnataka", notes: KA },
  { date: "2026-01-26", name: "Republic Day", type: "regional", region: "Karnataka", notes: KA },
  { date: "2026-02-15", name: "Maha Shivaratri", type: "regional", region: "Karnataka", notes: `${KA} Falls on a Sunday.` },
  { date: "2026-03-19", name: "Ugadi", type: "regional", region: "Karnataka", notes: KA },
  { date: "2026-03-21", name: "Id-ul-Fitr", type: "regional", region: "Karnataka", notes: KA },
  { date: "2026-03-31", name: "Mahavir Jayanti", type: "regional", region: "Karnataka", notes: KA },
  { date: "2026-04-03", name: "Good Friday", type: "regional", region: "Karnataka", notes: KA },
  { date: "2026-04-14", name: "Dr. B.R. Ambedkar Jayanti", type: "regional", region: "Karnataka", notes: KA },
  { date: "2026-04-20", name: "Basava Jayanti / Akshaya Tritiya", type: "regional", region: "Karnataka", notes: KA },
  { date: "2026-05-01", name: "May Day", type: "regional", region: "Karnataka", notes: KA },
  { date: "2026-05-28", name: "Bakrid", type: "regional", region: "Karnataka", notes: `${KA} The national gazette gives 27 May.` },
  { date: "2026-06-26", name: "Last Day of Muharram", type: "regional", region: "Karnataka", notes: KA },
  { date: "2026-08-15", name: "Independence Day", type: "regional", region: "Karnataka", notes: KA },
  { date: "2026-08-26", name: "Eid Milad-un-Nabi", type: "regional", region: "Karnataka", notes: KA },
  { date: "2026-09-14", name: "Ganesh Chaturthi", type: "regional", region: "Karnataka", notes: KA },
  { date: "2026-10-02", name: "Gandhi Jayanti", type: "regional", region: "Karnataka", notes: KA },
  { date: "2026-10-20", name: "Mahanavami / Ayudha Puja", type: "regional", region: "Karnataka", notes: KA },
  { date: "2026-10-21", name: "Vijayadashami", type: "regional", region: "Karnataka", notes: KA },
  { date: "2026-11-01", name: "Kannada Rajyotsava", type: "regional", region: "Karnataka", notes: `${KA} Falls on a Sunday.` },
  { date: "2026-11-08", name: "Naraka Chaturdashi", type: "regional", region: "Karnataka", notes: `${KA} Falls on a Sunday. The national list calls this day Diwali.` },
  { date: "2026-11-10", name: "Balipadyami (Deepavali)", type: "regional", region: "Karnataka", notes: `${KA} This is the Diwali day Karnataka gives leave for.` },
  { date: "2026-11-27", name: "Kanakadasa Jayanti", type: "regional", region: "Karnataka", notes: KA },
  { date: "2026-12-25", name: "Christmas", type: "regional", region: "Karnataka", notes: KA },

  // ── NATIONAL 2027 ──
  { date: "2027-01-14", name: "Makar Sankranti", type: "national", notes: GAZ },
  { date: "2027-01-26", name: "Republic Day", type: "national", notes: GAZ },
  { date: "2027-03-22", name: "Holi", type: "national", notes: `${GAZ} NOTE: the muhurat source lists this date as South Indian auspicious — needs a human ruling.` },
  { date: "2027-04-19", name: "Mahavir Jayanti", type: "national", notes: GAZ },
  { date: "2027-08-15", name: "Independence Day", type: "national", notes: GAZ },
  { date: "2027-10-02", name: "Gandhi Jayanti", type: "national", notes: GAZ },
  { date: "2027-10-29", name: "Diwali", type: "national", notes: GAZ },
  { date: "2027-12-25", name: "Christmas", type: "national", notes: GAZ },
  // Karnataka 2027: NOT SEEDED — the state had not published it when this was
  // written. See the header.
];

// ── safety gates ────────────────────────────────────────────────────────────
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

function writeBackup(payload) {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(BACKUP_DIR, `wedding-calendar-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  return file;
}

async function run() {
  const host = assertMongoTarget();
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 8000 });
  console.log(`${TAG} connected @ ${host} (${APPLY ? "APPLY" : "DRY-RUN"})`);

  const muhurKeys = Object.keys(MUHURAT).sort();
  const muhurStarts = muhurKeys.map((k) => toDayStart(k));
  const holidayStarts = HOLIDAYS.map((h) => toDayStart(h.date));

  // What already exists, so the dry-run can report create-vs-update honestly
  // and the apply can back up exactly what it will overwrite.
  const [existingMuhur, existingBlackouts, existingHolidays] = await Promise.all([
    AuspiciousDate.find({ date: { $in: muhurStarts }, region: null }).lean(),
    BlackoutPeriod.find({ $or: BLACKOUTS.map((b) => ({ name: b.name, startDate: toDayStart(b.startDate) })) }).lean(),
    PublicHoliday.find({ date: { $in: holidayStarts } }).lean(),
  ]);

  const muhurByKey = new Map(existingMuhur.map((r) => [r.date.toISOString().slice(0, 10), r]));
  const blackoutByKey = new Map(existingBlackouts.map((r) => [`${r.name}|${r.startDate.toISOString().slice(0, 10)}`, r]));
  const holidayByKey = new Map(
    existingHolidays.map((r) => [`${r.date.toISOString().slice(0, 10)}|${r.name}|${r.region || ""}`, r])
  );

  const plan = {
    muhurat: { create: 0, update: 0 },
    blackouts: { create: 0, update: 0 },
    holidays: { create: 0, update: 0 },
  };
  for (const k of muhurKeys) (muhurByKey.has(k) ? plan.muhurat.update++ : plan.muhurat.create++);
  for (const b of BLACKOUTS) {
    (blackoutByKey.has(`${b.name}|${b.startDate}`) ? plan.blackouts.update++ : plan.blackouts.create++);
  }
  for (const h of HOLIDAYS) {
    const key = `${h.date}|${h.name}|${h.region || ""}`;
    (holidayByKey.has(key) ? plan.holidays.update++ : plan.holidays.create++);
  }

  // Breakdown by tradition, so the dry-run report is readable as data rather
  // than as a single total.
  const byTradition = { north_only: 0, south_only: 0, both: 0, unspecified: 0 };
  for (const k of muhurKeys) {
    const t = MUHURAT[k];
    if (!t.length) byTradition.unspecified++;
    else if (t.includes(N) && t.includes(S)) byTradition.both++;
    else if (t.includes(N)) byTradition.north_only++;
    else byTradition.south_only++;
  }

  console.log(`\n${TAG} MUHURAT DATES — ${muhurKeys.length} total`);
  console.log(`  ${plan.muhurat.create} new, ${plan.muhurat.update} already present`);
  console.log(`  by tradition: both ${byTradition.both} · north only ${byTradition.north_only} · south only ${byTradition.south_only} · unspecified ${byTradition.unspecified}`);
  const byMonth = {};
  for (const k of muhurKeys) byMonth[k.slice(0, 7)] = (byMonth[k.slice(0, 7)] || 0) + 1;
  console.log(`  by month: ${Object.entries(byMonth).map(([m, n]) => `${m}=${n}`).join(" ")}`);

  console.log(`\n${TAG} BLACKOUT PERIODS — ${BLACKOUTS.length} total`);
  console.log(`  ${plan.blackouts.create} new, ${plan.blackouts.update} already present`);
  for (const b of BLACKOUTS) {
    console.log(`    ${b.name.padEnd(13)} ${b.startDate} → ${b.endDate}  ${b.traditions.length ? b.traditions.join("+") : "all traditions"}`);
  }

  const natCount = HOLIDAYS.filter((h) => h.type === "national").length;
  const regCount = HOLIDAYS.length - natCount;
  console.log(`\n${TAG} PUBLIC HOLIDAYS — ${HOLIDAYS.length} total (${natCount} national, ${regCount} regional)`);
  console.log(`  ${plan.holidays.create} new, ${plan.holidays.update} already present`);
  const holByYear = {};
  for (const h of HOLIDAYS) {
    const y = h.date.slice(0, 4);
    const bucket = h.type === "national" ? `${y} national` : `${y} ${h.region}`;
    holByYear[bucket] = (holByYear[bucket] || 0) + 1;
  }
  console.log(`  ${Object.entries(holByYear).map(([b, n]) => `${b}=${n}`).join(" · ")}`);
  console.log(`  Karnataka 2027: NOT SEEDED — the state publishes in late Nov/Dec of the preceding year.`);

  const flagged = [
    ...Object.keys(MUHURAT_NOTES),
    ...HOLIDAYS.filter((h) => /CONFLICT|NOTE:/.test(h.notes || "")).map((h) => `${h.date} ${h.name}`),
  ];
  console.log(`\n${TAG} ROWS CARRYING A FLAGGED CONFLICT — ${flagged.length}`);
  for (const f of flagged) console.log(`    ${f}`);
  console.log(`${TAG} everything is written verified:false — nothing here claims to be checked.`);

  if (!APPLY) {
    console.log(`\n${TAG} DRY-RUN — nothing written. Re-run with --apply to seed.`);
    await mongoose.disconnect();
    console.log(`${TAG} DONE`);
    return;
  }

  // BACKUP FIRST — every row this run could overwrite, as it is now.
  const file = writeBackup({
    takenAt: new Date().toISOString(),
    host,
    auspiciousDates: existingMuhur,
    blackoutPeriods: existingBlackouts,
    publicHolidays: existingHolidays,
  });
  console.log(`\n${TAG} backed up ${existingMuhur.length + existingBlackouts.length + existingHolidays.length} existing row(s) → ${file}`);

  const muhurOps = muhurKeys.map((key) => {
    const { year, month, day } = dayParts(key);
    return {
      updateOne: {
        filter: { date: toDayStart(key), region: null },
        update: {
          $set: {
            traditions: MUHURAT[key],
            notes: MUHURAT_NOTES[key] || SRC,
            // Never flips an already-verified row back to false: a human who
            // checked a date must not lose that by someone re-running the seed.
            ...(muhurByKey.has(key) && muhurByKey.get(key).verified ? {} : { verified: false }),
          },
          $setOnInsert: { date: toDayStart(key), region: null, year, month, day, tier: null },
        },
        upsert: true,
      },
    };
  });
  const mr = await AuspiciousDate.bulkWrite(muhurOps, { ordered: false });
  console.log(`${TAG} muhurat  → ${mr.upsertedCount || 0} created, ${mr.matchedCount || 0} updated`);

  const blackoutOps = BLACKOUTS.map((b) => ({
    updateOne: {
      filter: { name: b.name, startDate: toDayStart(b.startDate) },
      update: {
        $set: { endDate: toDayStart(b.endDate), traditions: b.traditions, notes: b.notes },
        $setOnInsert: {
          name: b.name,
          startDate: toDayStart(b.startDate),
          year: dayParts(b.startDate).year,
          verified: false,
        },
      },
      upsert: true,
    },
  }));
  const br = await BlackoutPeriod.bulkWrite(blackoutOps, { ordered: false });
  console.log(`${TAG} blackout → ${br.upsertedCount || 0} created, ${br.matchedCount || 0} updated`);

  const holidayOps = HOLIDAYS.map((h) => ({
    updateOne: {
      filter: { date: toDayStart(h.date), name: h.name, region: h.region || null },
      update: {
        $set: { type: h.type, notes: h.notes || "" },
        $setOnInsert: {
          date: toDayStart(h.date),
          name: h.name,
          region: h.region || null,
          year: dayParts(h.date).year,
          verified: false,
        },
      },
      upsert: true,
    },
  }));
  const hr = await PublicHoliday.bulkWrite(holidayOps, { ordered: false });
  console.log(`${TAG} holidays → ${hr.upsertedCount || 0} created, ${hr.matchedCount || 0} updated`);

  await mongoose.disconnect();
  console.log(`${TAG} DONE`);
}

run().catch((err) => {
  console.error(`${TAG} FAILED: ${err.message}`);
  process.exit(1);
});
