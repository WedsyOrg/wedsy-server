/* READ-ONLY census — mention ids that are well-formed but resolve to no admin.
 *
 * WHY THIS EXISTS. Until the strict isId landed, every local id check was built
 * on mongoose's ObjectId.isValid(), which returns TRUE for any 12-character
 * string. Such a string does not throw at cast — it coerces to a well-formed
 * ObjectId matching nothing:
 *
 *     "123456789012" -> ObjectId 313233343536373839303132
 *
 * No error, no catch, no log. And in the two arrays below the ids were persisted
 * BEFORE any notification filter ran, so the write was never protected even
 * while the notify path was.
 *
 * That is what COULD happen. Whether it DID is a different question, and the
 * answer is only in production data. This counts it.
 *
 * WRITES NOTHING. No update, no create, no delete anywhere in this file. Safe
 * to run against production.
 *
 * Usage:  node scripts/audit-orphan-mention-ids.js
 *         node scripts/audit-orphan-mention-ids.js --list   (show the rows)
 */
require("dotenv").config();
const mongoose = require("mongoose");

const LIST = process.argv.includes("--list");

(async () => {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { console.error("DATABASE_URL is not set."); process.exit(1); }
  await mongoose.connect(dbUrl, { serverSelectionTimeoutMS: 10000 });
  console.log(`[orphan-mentions] ${dbUrl.replace(/\/\/[^@]*@/, "//<redacted>@").split("/").slice(0, 3).join("/")}  (READ ONLY)\n`);

  const LeadStep = require("../models/LeadStep");
  const LeadChatMessage = require("../models/LeadChatMessage");
  const CalendarEvent = require("../models/CalendarEvent");
  const Admin = require("../models/Admin");

  // Every admin id that exists. Compared as strings so a stored ObjectId and a
  // coerced one are judged on identity, not on type.
  const liveAdmins = new Set(
    (await Admin.find({}, { _id: 1 }).lean()).map((a) => String(a._id))
  );
  console.log(`admins on file: ${liveAdmins.size}\n`);

  const report = (label, rows) => {
    const total = rows.reduce((n, r) => n + r.ids.length, 0);
    const orphanRows = rows.filter((r) => r.orphans.length);
    const orphanIds = orphanRows.reduce((n, r) => n + r.orphans.length, 0);
    console.log(`${label}`);
    console.log(`   documents carrying mentions : ${rows.length}`);
    console.log(`   mention ids total           : ${total}`);
    console.log(`   ids resolving to NO admin   : ${orphanIds}   ${orphanIds ? "<-- look" : ""}`);
    console.log(`   documents affected          : ${orphanRows.length}`);
    if (LIST && orphanRows.length) {
      orphanRows.slice(0, 50).forEach((r) =>
        console.log(`     ${r.ref}  orphans: ${r.orphans.join(", ")}`)
      );
      if (orphanRows.length > 50) console.log(`     … ${orphanRows.length - 50} more`);
    }
    console.log();
    return orphanIds;
  };

  // ── 1. Step-note mentions ────────────────────────────────────────────────
  const steps = await LeadStep.find(
    { "notes.mentions.0": { $exists: true } },
    { leadId: 1, name: 1, "notes.mentions": 1, "notes.createdAt": 1 }
  ).lean();
  const stepRows = [];
  for (const s of steps) {
    for (const [i, n] of (s.notes || []).entries()) {
      const ids = (n.mentions || []).map(String);
      if (!ids.length) continue;
      stepRows.push({
        ref: `step ${s._id} note[${i}] (lead ${s.leadId})`,
        ids,
        orphans: ids.filter((id) => !liveAdmins.has(id)),
      });
    }
  }
  const a = report("1. STEP-NOTE mentions[]  (LeadStep.notes[].mentions)", stepRows);

  // ── 2. Chat-message mentions ─────────────────────────────────────────────
  const msgs = await LeadChatMessage.find(
    { "mentions.0": { $exists: true } },
    { leadId: 1, mentions: 1, createdAt: 1 }
  ).lean();
  const msgRows = msgs.map((m) => {
    const ids = (m.mentions || []).map(String);
    return { ref: `chat ${m._id} (lead ${m.leadId})`, ids, orphans: ids.filter((id) => !liveAdmins.has(id)) };
  });
  const b = report("2. CHAT-MESSAGE mentions[]  (LeadChatMessage.mentions)", msgRows);

  // ── 3. Meeting attendees ─────────────────────────────────────────────────
  // Included for completeness, and expected to be ZERO: MeetingService resolves
  // teamAdminIds through findAssignable and throws 422 when any fails to
  // resolve, so a poisoned id never reaches the document. A non-zero here would
  // mean that guard has a hole and is worth knowing.
  const events = await CalendarEvent.find(
    { "attendees.adminId": { $ne: null } },
    { leadId: 1, attendees: 1 }
  ).lean();
  const evRows = events.map((e) => {
    const ids = (e.attendees || []).map((x) => x.adminId).filter(Boolean).map(String);
    return { ref: `event ${e._id} (lead ${e.leadId})`, ids, orphans: ids.filter((id) => !liveAdmins.has(id)) };
  }).filter((r) => r.ids.length);
  const c = report("3. MEETING attendees[].adminId  (expected 0 — guarded by findAssignable)", evRows);

  console.log("─".repeat(64));
  console.log(`TOTAL ids resolving to no admin: ${a + b + c}`);
  console.log(
    (a + b + c)
      ? "Some mentions point at ids that do not exist. Re-run with --list to see them\nbefore anyone decides on a repair."
      : "No orphaned mention ids. The defect was reachable but was never exercised."
  );
  console.log("\nNothing was written.");
  await mongoose.disconnect();
})();
