/**
 * utils/venueDocAlert.js — fire-and-forget WhatsApp ping to the VENUE OWNER
 * when a couple accepts a quote through the public link. Public acceptance
 * deliberately does NOT auto-create the booking (owner is king, D5) — this
 * alert plus the dashboard "confirm booking" card make the pending action
 * unmissable instead.
 *
 * Gating mirrors utils/venueOpsAlert.js (opt-in, prod-safe by default):
 * log-only unless REMINDERS_LOG_ONLY=false; Meta Cloud only; never throws.
 */
const venueWhatsApp = require("./venueWhatsApp");
const { formatINR } = require("./venueMoney");

function ownerPhone(venue) {
  const c = venue.contact || {};
  return (c.whatsappPhone || c.primaryPhone || venue.phone || "").trim();
}

function formatQuoteAccepted(venue, quote, partyName) {
  return [
    `Quote accepted — confirm the booking`,
    `${partyName || "The couple"} accepted quote v${quote.version || 1} (${formatINR((quote.totals && quote.totals.grandTotal) || 0)}).`,
    `Open your Wedsy Partner dashboard to confirm the booking and lock the dates.`,
  ].join("\n");
}

async function notifyQuoteAccepted(venue, quote, partyName) {
  try {
    const phone = ownerPhone(venue);
    if (!phone) return { skipped: "no owner phone" };
    const message = formatQuoteAccepted(venue, quote, partyName);
    const logOnly = process.env.REMINDERS_LOG_ONLY !== "false"; // default true
    if (logOnly) {
      console.log(`[docAlert][log-only] to=${phone}\n${message}`);
      return { logged: true, message };
    }
    if (!venueWhatsApp.isConfigured()) {
      console.log("[docAlert] WhatsApp not configured — skipping send");
      return { skipped: "whatsapp unconfigured" };
    }
    const result = await venueWhatsApp.sendText(phone, message);
    if (!result.ok) console.log(`[docAlert] send failed: ${result.error}`);
    return result;
  } catch (err) {
    console.log(`[docAlert] error (ignored): ${err.message}`);
    return { ok: false, error: err.message };
  }
}

module.exports = { notifyQuoteAccepted, formatQuoteAccepted };
