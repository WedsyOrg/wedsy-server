/* WHICH LEAD SOURCES ACTUALLY MEAN "CAME FROM A META AD" — read-only census.
 *
 * WHY THIS RUNS BEFORE THE CONVERSIONS API SHIPS. Without Meta's lead_id we
 * match a person by hashed phone, and Meta will happily match somebody who
 * never saw an ad. Sending a website, WhatsApp or walk-in lead therefore
 * credits organic business to the campaigns and teaches the algorithm to buy
 * more of the wrong thing. The gate has to be an EXPLICIT set of source
 * values, and the set has to come from data rather than from what the strings
 * look like.
 *
 * THE STRINGS LIE, WHICH IS THE POINT OF MEASURING. Reading the writers:
 *   - controllers/webhook.js (the Make → OS ad bridge) lowercases campaign
 *     labels, so a Meta ad lead can be stored as bare "instagram".
 *   - services/InstagramAgentService.js stores organic Instagram DM leads as
 *     bare "instagram" TOO.
 * Same string, two origins, one of which must never be sent. Section 3 splits
 * them on the discriminators each writer leaves behind.
 *
 * READ-ONLY. No writes, no Meta call. Safe on production.
 *
 *   node scripts/audit-lead-source-meta-origin.js
 *   node scripts/audit-lead-source-meta-origin.js --qualified-only
 */
require("dotenv").config();
const mongoose = require("mongoose");

const QUALIFIED_ONLY = process.argv.includes("--qualified-only");
const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL unset — refusing to run.");
    process.exit(1);
  }
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  const Enquiry = require("../models/Enquiry");

  const scope = QUALIFIED_ONLY ? { qualified: true } : {};
  console.log(`\nscope: ${QUALIFIED_ONLY ? "QUALIFIED leads only" : "ALL leads"}`);
  console.log(`total: ${await Enquiry.countDocuments(scope)}\n`);

  // ── 1. Every distinct source value, with how many ever qualify ────────────
  // Qualification is what triggers a send, so a source that never qualifies
  // cannot cost anything either way — that is worth seeing per row.
  console.log("1. DISTINCT source VALUES");
  const bySource = await Enquiry.aggregate([
    { $match: scope },
    { $group: {
        _id: { $ifNull: ["$source", "(unset)"] },
        total: { $sum: 1 },
        qualified: { $sum: { $cond: [{ $eq: ["$qualified", true] }, 1, 0] } },
      } },
    { $sort: { total: -1 } },
  ]);
  console.log(`   ${pad("source", 38)} ${num("total", 7)} ${num("qualified", 10)}`);
  for (const r of bySource) {
    console.log(`   ${pad(JSON.stringify(r._id), 38)} ${num(r.total, 7)} ${num(r.qualified, 10)}`);
  }

  // ── 2. Can we even identify them? ────────────────────────────────────────
  // A send carries hashed em/ph and nothing else. A lead with no usable phone
  // and no email is unsendable no matter what its source says. "ig:" phones
  // are IG placeholders (services/InstagramAgentService.js), NOT phone
  // numbers — hashing one would send Meta a fabricated identifier.
  console.log("\n2. IDENTIFIABILITY (what a send could actually carry)");
  const ident = await Enquiry.aggregate([
    { $match: scope },
    { $project: {
        source: 1,
        placeholder: { $regexMatch: { input: { $ifNull: ["$phone", ""] }, regex: /^ig:/ } },
        digits: { $strLenCP: { $ifNull: ["$phone", ""] } },
        hasEmail: { $gt: [{ $strLenCP: { $ifNull: ["$email", ""] } }, 0] },
      } },
    { $group: {
        _id: null,
        total: { $sum: 1 },
        placeholderPhone: { $sum: { $cond: ["$placeholder", 1, 0] } },
        noPhone: { $sum: { $cond: [{ $lt: ["$digits", 7] }, 1, 0] } },
        withEmail: { $sum: { $cond: ["$hasEmail", 1, 0] } },
      } },
  ]);
  const i = ident[0] || {};
  console.log(`   leads                       ${num(i.total || 0, 7)}`);
  console.log(`   with an email               ${num(i.withEmail || 0, 7)}`);
  console.log(`   phone is an "ig:" placeholder ${num(i.placeholderPhone || 0, 5)}  <- NEVER hashable`);
  console.log(`   phone too short / absent    ${num(i.noPhone || 0, 7)}`);

  // ── 3. THE COLLISION: bare "instagram" split by origin ───────────────────
  // additionalInfo.instagramId is written ONLY by the IG DM agent.
  // additionalInfo.adFormAnswers is written by the ad-form webhook — but ALSO
  // by KiaraFactExtractionService on DM leads, so it is not proof on its own.
  // instagramId is the trustworthy negative signal: if it is set, the lead
  // walked in through a DM, not through an ad.
  console.log("\n3. THE 'instagram' COLLISION — organic DM vs Meta ad form");
  const igSplit = await Enquiry.aggregate([
    { $match: { ...scope, source: { $regex: /^instagram/i } } },
    { $group: {
        _id: {
          source: "$source",
          dmAgent: { $gt: [{ $strLenCP: { $ifNull: ["$additionalInfo.instagramId", ""] } }, 0] },
          adForm: { $gt: [{ $size: { $objectToArray: { $ifNull: ["$additionalInfo.adFormAnswers", {}] } } }, 0] },
        },
        n: { $sum: 1 },
      } },
    { $sort: { n: -1 } },
  ]);
  if (!igSplit.length) console.log("   (no instagram-sourced leads)");
  console.log(`   ${pad("source", 26)} ${pad("instagramId", 12)} ${pad("adFormAnswers", 14)} ${num("n", 5)}`);
  for (const r of igSplit) {
    console.log(`   ${pad(JSON.stringify(r._id.source), 26)} ${pad(r._id.dmAgent ? "SET (DM)" : "-", 12)} ${pad(r._id.adForm ? "SET" : "-", 14)} ${num(r.n, 5)}`);
  }

  // ── 4. The ad-form bridge's own vocabulary ───────────────────────────────
  // resolveSource() in controllers/webhook.js only ever emits: the literal
  // "Ads (Landing Screen)" default, "landing_page", or a lowercased
  // facebook*/instagram* campaign label. Anything else under those shapes came
  // from somewhere else and is worth seeing.
  console.log("\n4. AD-BRIDGE VOCABULARY (what resolveSource can emit)");
  const bridge = await Enquiry.aggregate([
    { $match: { ...scope, $or: [
        { source: "Ads (Landing Screen)" },
        { source: "landing_page" },
        { source: { $regex: /^(facebook|instagram)(_[a-z0-9]+)*$/ } },
      ] } },
    { $group: { _id: "$source", n: { $sum: 1 },
        withAdForm: { $sum: { $cond: [{ $gt: [{ $size: { $objectToArray: { $ifNull: ["$additionalInfo.adFormAnswers", {}] } } }, 0] }, 1, 0] } } } },
    { $sort: { n: -1 } },
  ]);
  if (!bridge.length) console.log("   (none)");
  console.log(`   ${pad("source", 38)} ${num("n", 6)} ${num("w/ adFormAnswers", 18)}`);
  for (const r of bridge) {
    console.log(`   ${pad(JSON.stringify(r._id), 38)} ${num(r.n, 6)} ${num(r.withAdForm, 18)}`);
  }

  console.log("\nDECIDE FROM THIS: which of the section-1 values mean 'this person");
  console.log("clicked a Meta ad'. That set becomes META_AD_SOURCES in");
  console.log("services/MetaConversionsService.js. Everything else is skipped.\n");

  await mongoose.disconnect();
})().catch((e) => { console.error("census failed:", e.message); process.exit(1); });
