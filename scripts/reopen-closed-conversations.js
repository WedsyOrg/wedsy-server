/* ONE-OFF REPAIR — reopen closed conversations holding unanswered customer messages.
 *
 * Production, 6 Sep 2026: 35 closed conversations, 27 holding unread inbound —
 * 154 real customer messages nobody answered. 17 of those are unlinked Instagram
 * threads where not even the owner bell fired: total silence.
 *
 * The forward fix (upsertOnInbound reopens on a customer message) does NOTHING
 * for these. They are already closed, the messages already arrived, and no
 * further inbound is guaranteed. They need repairing by hand, once.
 *
 * ── SELECTION ───────────────────────────────────────────────────────────────
 *   status: "closed"  AND  unreadCount > 0
 *
 * unreadCount is the honest proxy: getMessages() zeroes it the moment a human
 * opens a thread, so a closed thread with unread > 0 means customer messages
 * arrived and NOBODY has looked. It needs no closedAt, which these rows predate.
 *
 * NOT all 35. The 8 closed threads with no unread were closed and never
 * messaged again — reopening those would push dead conversations back into the
 * inbox for no reason.
 *
 * ── WHAT IT DOES, AND DELIBERATELY DOES NOT ─────────────────────────────────
 * Writes exactly two fields: status → "active", reopenedAt → now.
 *
 * It sends NOTHING. It triggers no Kiara reply. Some of these messages are weeks
 * old, and auto-answering would push a bot message to 27 people about a
 * conversation they have probably given up on — which reads worse than the
 * silence did. Reopening makes them VISIBLE; a human decides what to say to
 * someone who was ignored for a fortnight. That is not a call a script gets to
 * make quietly.
 *
 * Idempotent: a second run selects nothing (the rows are active by then).
 *
 * Usage:
 *   node scripts/reopen-closed-conversations.js            # DRY RUN — reports only
 *   node scripts/reopen-closed-conversations.js --confirm  # apply
 */
require("dotenv").config();
const mongoose = require("mongoose");

const CONFIRM = process.argv.includes("--confirm");
// Expected shape from the 6 Sep production count. A material mismatch means the
// data moved under us and the operator should stop and look rather than confirm.
const EXPECTED = { threads: 27, messages: 154 };

const ago = (d) => {
  if (!d) return "never";
  const days = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
  return days === 0 ? "today" : `${days}d ago`;
};

(async () => {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { console.error("DATABASE_URL is not set."); process.exit(1); }
  await mongoose.connect(dbUrl, { serverSelectionTimeoutMS: 10000 });
  console.log(`[reopen] ${dbUrl.replace(/\/\/[^@]*@/, "//<redacted>@").split("/").slice(0, 3).join("/")}`);
  console.log(`[reopen] mode: ${CONFIRM ? ">>> APPLY <<<" : "DRY RUN — nothing is written"}\n`);

  const WAConversation = require("../models/WAConversation");
  const Enquiry = require("../models/Enquiry");
  const Admin = require("../models/Admin");

  try {
    const filter = { status: "closed", unreadCount: { $gt: 0 } };
    const rows = await WAConversation.find(filter, {
      phone: 1, channel: 1, profileName: 1, enquiryId: 1,
      unreadCount: 1, lastInboundAt: 1, lastMessagePreview: 1, closedAt: 1,
    }).sort({ lastInboundAt: -1 }).lean();

    if (!rows.length) {
      console.log("[reopen] nothing to repair — no closed thread holds unread messages.");
      return;
    }

    // Owner names where a lead exists, so the operator can see who to tell.
    const leadIds = rows.map((r) => r.enquiryId).filter(Boolean);
    const leads = leadIds.length
      ? await Enquiry.find({ _id: { $in: leadIds } }, { name: 1, assignedTo: 1 }).lean()
      : [];
    const leadById = new Map(leads.map((l) => [String(l._id), l]));
    const ownerIds = [...new Set(leads.map((l) => l.assignedTo).filter(Boolean).map(String))];
    const owners = ownerIds.length
      ? await Admin.find({ _id: { $in: ownerIds } }, { name: 1 }).lean()
      : [];
    const ownerById = new Map(owners.map((o) => [String(o._id), o.name]));

    let messages = 0, silent = 0;
    console.log("  thread                          ch    unread  last inbound   who");
    console.log("  " + "-".repeat(84));
    for (const r of rows) {
      messages += r.unreadCount || 0;
      const lead = r.enquiryId ? leadById.get(String(r.enquiryId)) : null;
      const owner = lead && lead.assignedTo ? ownerById.get(String(lead.assignedTo)) : null;
      // TIER 2 — no lead means the owner bell never fired either: total silence.
      const tier2 = !lead || !owner;
      if (tier2) silent++;
      console.log(
        `  ${(r.profileName || r.phone).slice(0, 30).padEnd(30)}  ${(r.channel || "").slice(0, 4).padEnd(4)}  ` +
        `${String(r.unreadCount).padStart(6)}  ${ago(r.lastInboundAt).padStart(12)}   ` +
        (tier2 ? "— NOBODY WAS TOLD" : `${lead.name} / ${owner}`)
      );
    }

    console.log("\n  " + "-".repeat(84));
    console.log(`  threads:  ${rows.length}${rows.length !== EXPECTED.threads ? `   ⚠ expected ${EXPECTED.threads}` : ""}`);
    console.log(`  messages: ${messages}${messages !== EXPECTED.messages ? `   ⚠ expected ${EXPECTED.messages}` : ""}`);
    console.log(`  of which nobody was told at all: ${silent}`);
    if (rows.length !== EXPECTED.threads || messages !== EXPECTED.messages) {
      console.log("\n  ⚠ The counts differ from the 6 Sep measurement. Read the list above before");
      console.log("    confirming — the data has moved, and this script should not be run blind.");
    }

    if (!CONFIRM) {
      console.log("\n[reopen] DRY RUN — nothing written. Re-run with --confirm to apply.");
      console.log("[reopen] Reopening makes these VISIBLE. It sends nothing; deciding what to");
      console.log("         say to someone ignored for weeks is a human's job, not this script's.");
      return;
    }

    const res = await WAConversation.updateMany(filter, {
      $set: { status: "active", reopenedAt: new Date() },
    });
    console.log(`\n[reopen] reopened ${res.modifiedCount} conversation(s).`);
    console.log("[reopen] They are now in the inbox. Nothing was sent to anyone.");
  } catch (error) {
    console.error("[reopen] FAILED:", error.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
