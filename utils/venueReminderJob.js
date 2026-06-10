/**
 * utils/venueReminderJob.js — Phase 1.4 (optional) follow-up reminder scaffold.
 *
 * Daily job: for each venue that has leads with a follow-up due TODAY, send the
 * owner a WhatsApp summary via the Meta Cloud API.
 *
 *  - Env-gated: with no WhatsApp creds it no-ops gracefully (logs, never throws).
 *  - Log-only mode (REMINDERS_LOG_ONLY, default "true"): compose + log the
 *    summary but DO NOT actually send. Set REMINDERS_LOG_ONLY=false to send.
 */
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueOwner = require("../models/VenueOwner");
const { sendWhatsAppText } = require("./whatsapp");

const TERMINAL_STAGES = ["booked", "lost"];

function whatsappConfigured() {
  const token = process.env.WHATSAPP_CLOUD_TOKEN || process.env.META_WA_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.META_WA_PHONE_NUMBER_ID;
  return Boolean(token && phoneId);
}

async function runDailyFollowUpReminders() {
  try {
    const logOnly = process.env.REMINDERS_LOG_ONLY !== "false"; // default true
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

    // Count of leads due today, grouped by venue.
    const dueToday = await VenueEnquiry.aggregate([
      { $match: { stage: { $nin: TERMINAL_STAGES }, followUpDate: { $gte: startOfToday, $lte: endOfToday } } },
      { $group: { _id: "$venueId", count: { $sum: 1 } } },
    ]);

    if (!dueToday.length) {
      console.log("[venueReminders] no venues with follow-ups due today");
      return { venues: 0, sent: 0 };
    }

    const configured = whatsappConfigured();
    let sent = 0;
    for (const row of dueToday) {
      const owners = await VenueOwner.find({ venueId: row._id, isActive: true }).select("phone name").lean();
      const summary = `Wedsy reminder: you have ${row.count} lead${row.count === 1 ? "" : "s"} with a follow-up due today. Open your dashboard to act on them.`;
      for (const owner of owners) {
        if (logOnly || !configured) {
          console.log(`[venueReminders]${logOnly ? " (log-only)" : " (no creds)"} -> ${owner.phone}: ${summary}`);
          continue;
        }
        try {
          await sendWhatsAppText(owner.phone, summary);
          sent += 1;
        } catch (e) {
          console.error(`[venueReminders] send failed for ${owner.phone}:`, e.message);
        }
      }
    }
    console.log(`[venueReminders] venues=${dueToday.length} sent=${sent} logOnly=${logOnly} configured=${configured}`);
    return { venues: dueToday.length, sent };
  } catch (err) {
    console.error("[venueReminders] error:", err.message);
    return { error: err.message };
  }
}

module.exports = { runDailyFollowUpReminders, whatsappConfigured };
