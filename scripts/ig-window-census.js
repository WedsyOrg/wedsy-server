/* READ-ONLY census of Instagram conversations against the messaging windows.
 *
 * Quantifies the hole the HUMAN_AGENT work closes, before anyone designs around
 * a guess. WRITES NOTHING — no updateOne, no create, no delete anywhere in this
 * file. Safe to run against production.
 *
 * THE CLOCK IS lastInboundAt — the customer's last message — because that is
 * the clock Meta runs. Not thread creation, not last activity: an outbound
 * staff message does not extend anything.
 *
 *   1. UNREACHABLE NOW      past 24h, no human reply. Cannot be answered today.
 *   2. RECOVERABLE ON SHIP  of those, still inside 7 days. These become
 *                           answerable the moment this deploys — and they drain
 *                           continuously whether anyone works them or not.
 *   3. ALREADY LOST         past 7 days, no human reply. Reported RAW and
 *                           QUALIFIED; see the warning below.
 *
 * ⚠ COUNT 3 IS NOT "LEADS WE LOST" AND MUST NOT BE QUOTED AS ONE. Plenty of
 * those people came back on WhatsApp, or gave a phone number and had the thread
 * merged into an existing lead. The RAW number is the size of the set; the
 * QUALIFIED number excludes any conversation whose lead later showed activity
 * through another channel or acquired a real phone. The qualified number is the
 * honest one.
 *
 * The recoverable list is sorted by TIME REMAINING, soonest expiry first —
 * deliberately, not by lead value or recency. The 7-day clock drains from the
 * bottom every day; sorting any other way works the wrong end of the list.
 *
 * Usage:  node scripts/ig-window-census.js            (summary)
 *         node scripts/ig-window-census.js --list     (+ the work list)
 */
require("dotenv").config();
const mongoose = require("mongoose");

const LIST = process.argv.includes("--list");
const WINDOW_MS = 24 * 60 * 60 * 1000;
const HUMAN_AGENT_MS = 7 * 24 * 60 * 60 * 1000;

const fmt = (ms) => {
  if (ms == null) return "—";
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  return `${d}d ${String(h).padStart(2, "0")}h`;
};

(async () => {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { console.error("DATABASE_URL is not set."); process.exit(1); }
  await mongoose.connect(dbUrl, { serverSelectionTimeoutMS: 10000 });
  console.log(`[census] ${dbUrl.replace(/\/\/[^@]*@/, "//<redacted>@").split("/").slice(0, 3).join("/")}  (READ ONLY)\n`);

  const WAConversation = require("../models/WAConversation");
  const WAAgentMessage = require("../models/WAAgentMessage");
  const Enquiry = require("../models/Enquiry");

  const now = Date.now();
  const igs = await WAConversation.find({ channel: "instagram" }, {
    phone: 1, profileName: 1, lastInboundAt: 1, enquiryId: 1, mode: 1, status: 1,
  }).lean();

  // "No human reply" = no assistant message carrying sentBy (a staff send).
  // Kiara's replies have sentBy null, so they correctly do NOT count as human.
  const humanRepliedPhones = new Set(
    (await WAAgentMessage.distinct("phone", {
      role: "assistant", sentBy: { $ne: null },
      phone: { $in: igs.map((c) => c.phone) },
    })) || []
  );

  const rows = [];
  for (const c of igs) {
    if (!c.lastInboundAt) continue;
    const age = now - new Date(c.lastInboundAt).getTime();
    rows.push({
      ...c,
      age,
      humanReplied: humanRepliedPhones.has(c.phone),
      msRemaining: HUMAN_AGENT_MS - age,
    });
  }

  const noHuman = rows.filter((r) => !r.humanReplied);
  const unreachableNow = noHuman.filter((r) => r.age > WINDOW_MS);
  const recoverable = unreachableNow.filter((r) => r.msRemaining > 0)
    .sort((a, b) => a.msRemaining - b.msRemaining);   // soonest expiry FIRST
  const alreadyLostRaw = noHuman.filter((r) => r.msRemaining <= 0);

  // QUALIFY count 3: drop any whose lead later showed life elsewhere.
  const leadIds = alreadyLostRaw.map((r) => r.enquiryId).filter(Boolean);
  const leads = leadIds.length
    ? await Enquiry.find({ _id: { $in: leadIds } }, {
        phone: 1, source: 1, additionalInfo: 1, stage: 1,
      }).lean()
    : [];
  const leadById = new Map(leads.map((l) => [String(l._id), l]));

  // Which of these leads also has a WHATSAPP conversation? That is a real
  // "came back through another channel" signal.
  //
  // NOT lead.updatedAt, deliberately. updatedAt moves for all sorts of reasons
  // that are not the customer returning — lane sweeps, escalation marks,
  // assignment changes, any automated write — so using it silently excludes
  // genuinely lost threads and reports a loss SMALLER than reality. An honest
  // number should not flatter us by accident.
  const waLeadIds = new Set(
    (await WAConversation.distinct("enquiryId", {
      channel: "whatsapp",
      enquiryId: { $in: leadIds },
    })).filter(Boolean).map(String)
  );

  const cameBackElsewhere = (r) => {
    const lead = r.enquiryId ? leadById.get(String(r.enquiryId)) : null;
    if (!lead) return false;
    // A real phone means the number was captured — reachable off Instagram.
    const hasRealPhone = lead.phone && !String(lead.phone).startsWith("ig:");
    // The same lead is also talking to us on WhatsApp.
    const onWhatsApp = waLeadIds.has(String(lead._id));
    // Merged into an existing lead.
    const merged = !!(lead.additionalInfo && lead.additionalInfo.mergedIntoLeadId);
    return hasRealPhone || onWhatsApp || merged;
  };
  const alreadyLostQualified = alreadyLostRaw.filter((r) => !cameBackElsewhere(r));

  console.log(`Instagram conversations with an inbound: ${rows.length}`);
  console.log(`  of which no human has ever replied:    ${noHuman.length}\n`);
  console.log(`1. UNREACHABLE NOW     (past 24h, no human reply)          ${unreachableNow.length}`);
  console.log(`2. RECOVERABLE ON SHIP (of those, still inside 7 days)     ${recoverable.length}`);
  console.log(`3. ALREADY LOST        (past 7 days, no human reply)`);
  console.log(`     raw                                                  ${alreadyLostRaw.length}`);
  console.log(`     qualified — excludes leads that came back elsewhere   ${alreadyLostQualified.length}   <- the honest number`);

  if (recoverable.length) {
    console.log(`\nRecoverable window drains continuously. Soonest expiries:`);
    for (const r of recoverable.slice(0, LIST ? 500 : 10)) {
      console.log(
        `   ${fmt(r.msRemaining).padStart(7)} left  @${(r.profileName || r.phone).slice(0, 24).padEnd(24)}  lead=${r.enquiryId || "(none)"}`
      );
    }
    if (!LIST && recoverable.length > 10) console.log(`   … ${recoverable.length - 10} more — re-run with --list`);
  }

  await mongoose.disconnect();
})();
