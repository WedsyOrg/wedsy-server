/* PHONE DEDUP COLLISIONS — read-only census. Decides whether the dedup key changes.
 *
 * LeadIntakeService.normalizePhone() reduces a number to its LAST TEN DIGITS and
 * dedups on that:
 *
 *     Enquiry.findOne({ phone: { $regex: <last ten> + "$" } })
 *
 * For Indian numbers that is exactly right — it is what catches
 * "+91 98765 43210" against "9876543210". Across country codes it is not: two
 * different people in two different countries can share their last ten digits,
 * and the second one to enquire is silently merged into the first one's lead.
 * The merge is not visible as an error anywhere; it looks like a returning
 * customer.
 *
 * THIS SCRIPT CHANGES NOTHING. It connects to the database it is given, reads,
 * prints, and disconnects. No writes, no network, no Meta, no gateway. Safe to
 * run on production, and safe to re-run.
 *
 * WHAT THE NUMBER DECIDES. If collisions are zero, the dedup key can be left
 * alone and this stays as the guard that says so. If they are not, the ids
 * printed below are the leads to repair, and changing the key becomes a
 * migration rather than a one-line edit.
 *
 *   node scripts/audit-phone-dedup-collisions.js
 *   node scripts/audit-phone-dedup-collisions.js --all      # include the full id list
 */
require("dotenv").config();
const mongoose = require("mongoose");

const SHOW_ALL = process.argv.includes("--all");
const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);

// The dedup key exactly as LeadIntakeService computes it. Duplicated here
// DELIBERATELY and with intent: this script measures the CURRENT behaviour, so
// it must keep measuring the old rule even after the rule is changed —
// importing it would make the census silently agree with whatever it becomes.
const dedupKey = (phone) => {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
};

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set — refusing to run.");
    process.exit(1);
  }
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

  const Enquiry = require("../models/Enquiry");
  const { normalisePhone, defaultCountryCode } = require("../utils/phone");
  const DEFAULT_CC = defaultCountryCode();

  // normalisePhone logs "[phone] ASSUMED …" every time it defaults a country
  // code — correct in the application, useless here, where it would emit one
  // line per lead and bury the report. Silenced ONLY around the read loop, and
  // restored immediately: the shared normaliser is still the one deciding what
  // canonical means, which is the point.
  const realLog = console.log;
  const canonicalise = (raw) => {
    console.log = () => {};
    try { return normalisePhone(raw); } finally { console.log = realLog; }
  };

  const host = String(process.env.DATABASE_URL).replace(/\/\/[^@]*@/, "//<redacted>@").split("/").slice(0, 3).join("/");
  console.log("");
  console.log("─".repeat(72));
  console.log("PHONE DEDUP COLLISIONS — READ-ONLY CENSUS (nothing is written)");
  console.log("─".repeat(72));
  console.log(`  database        ${host}`);
  console.log(`  default cc      ${DEFAULT_CC}`);

  const leads = await Enquiry.find({}, { phone: 1, name: 1, source: 1, qualified: 1, createdAt: 1 })
    .sort({ createdAt: 1 })
    .lean();
  console.log(`  leads read      ${leads.length}`);

  // ── Shape of every stored number ──────────────────────────────────────────
  const shape = { placeholder: [], tooShort: [], noCountryCode: [], defaultCC: [], otherCC: [] };
  for (const l of leads) {
    const raw = String(l.phone || "").trim();
    if (/^ig:/i.test(raw)) { shape.placeholder.push(l); continue; }
    const hadPlus = raw.startsWith("+");
    const digits = raw.replace(/[^0-9]/g, "").replace(/^0+/, "");
    if (digits.length < 10) { shape.tooShort.push(l); continue; }
    if (!hadPlus && digits.length === 10) { shape.noCountryCode.push(l); continue; }
    if (digits.startsWith(DEFAULT_CC)) shape.defaultCC.push(l);
    else shape.otherCC.push(l);
  }

  console.log("");
  console.log("1. WHAT THE STORED NUMBERS LOOK LIKE");
  console.log(`   carries +${DEFAULT_CC}                     ${num(shape.defaultCC.length, 7)}`);
  console.log(`   carries a DIFFERENT country code  ${num(shape.otherCC.length, 7)}   <- the population at risk`);
  console.log(`   carries NO country code           ${num(shape.noCountryCode.length, 7)}   <- utils/phone must guess one`);
  console.log(`   "ig:" placeholder (no number yet) ${num(shape.placeholder.length, 7)}`);
  console.log(`   too short to be a number          ${num(shape.tooShort.length, 7)}`);

  if (shape.otherCC.length) {
    // Grouped by LEADING DIGITS, not by a parsed country code: the national
    // part is ten digits in India and nine in the UAE, so any fixed-width split
    // reports +971 as +97. Leading digits is what can be claimed honestly.
    const byPrefix = new Map();
    for (const l of shape.otherCC) {
      const p = String(l.phone).replace(/[^0-9]/g, "").replace(/^0+/, "").slice(0, 4);
      byPrefix.set(p, (byPrefix.get(p) || 0) + 1);
    }
    console.log("");
    console.log("   non-default numbers by leading digits:");
    for (const [p, n] of [...byPrefix.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`     ${pad(p, 8)} ${num(n, 5)}`);
    }
  }

  // ── The collisions themselves ─────────────────────────────────────────────
  // A collision is: two or more leads sharing a dedup key, whose canonical FULL
  // numbers are not the same. "9876543210" and "+91 98765 43210" canonicalise
  // to the same number and are correctly NOT a collision — that pair is the
  // whole reason the last-ten rule exists.
  const byKey = new Map();
  for (const l of leads) {
    const raw = String(l.phone || "").trim();
    if (/^ig:/i.test(raw)) continue; // placeholders never enter phone dedup
    const key = dedupKey(raw);
    if (key.length < 7) continue; // findExistingByNormalizedPhone ignores these
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push({ lead: l, canonical: canonicalise(raw) || raw.replace(/[^0-9]/g, "") });
  }

  const collisions = [];
  for (const [key, group] of byKey.entries()) {
    if (group.length < 2) continue;
    const distinct = new Set(group.map((g) => g.canonical));
    if (distinct.size > 1) collisions.push({ key, group, distinct: [...distinct] });
  }

  console.log("");
  console.log("2. COLLISIONS — leads sharing their last 10 digits with a DIFFERENT number");
  console.log(`   colliding dedup keys   ${num(collisions.length, 7)}`);
  console.log(`   leads involved         ${num(collisions.reduce((a, c) => a + c.group.length, 0), 7)}`);

  if (!collisions.length) {
    console.log("");
    console.log("   NONE. Every group sharing a last-10 key is the same number written");
    console.log("   two ways, which is exactly what the rule is for. On this data the");
    console.log("   dedup key is safe as it stands.");
  } else {
    console.log("");
    console.log("   THESE LEADS MAY ALREADY HAVE BEEN MERGED WRONGLY:");
    const show = SHOW_ALL ? collisions : collisions.slice(0, 20);
    for (const c of show) {
      console.log("");
      console.log(`   last-10 key ${c.key}  →  ${c.distinct.length} different numbers`);
      for (const { lead, canonical } of c.group) {
        console.log(
          `     ${lead._id}  ${pad(String(lead.name || "(no name)").slice(0, 22), 22)} ` +
            `${pad(canonical, 16)} ${pad(lead.source || "", 18)} ${lead.qualified ? "QUALIFIED" : ""}`
        );
      }
    }
    if (!SHOW_ALL && collisions.length > show.length) {
      console.log("");
      console.log(`   … and ${collisions.length - show.length} more. Re-run with --all for the full list.`);
    }
  }

  // ── The forward-looking risk ──────────────────────────────────────────────
  // Even with zero collisions today, the exposure is real the moment a
  // non-default number and a default one share ten digits.
  console.log("");
  console.log("3. EXPOSURE GOING FORWARD");
  if (!shape.otherCC.length) {
    console.log("   No lead carries a non-default country code, so the last-10 rule cannot");
    console.log("   currently collide across countries. That is a property of the DATA,");
    console.log("   not of the rule — it stops holding with the first international lead.");
  } else {
    console.log(`   ${shape.otherCC.length} lead(s) carry a non-default country code. Every one of them can`);
    console.log("   collide with an Indian number sharing its last ten digits, and the");
    console.log("   merge would look like a returning customer rather than an error.");
  }

  console.log("");
  console.log("─".repeat(72));
  console.log("Nothing was written. Collisions above decide whether the dedup key changes");
  console.log("(a migration) or stays as it is (and these leads get repaired).");
  console.log("─".repeat(72));
  console.log("");

  await mongoose.disconnect();
})().catch((e) => {
  console.error("census failed:", e.message);
  process.exit(1);
});
