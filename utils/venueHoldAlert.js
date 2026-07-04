/**
 * utils/venueHoldAlert.js — fire-and-forget WhatsApp ping to the VENUE OWNER
 * when a wedsy-side hold request lands (D3: holds are owner-approved requests,
 * so the owner must hear about them fast).
 *
 * Gating mirrors utils/venueOpsAlert.js (opt-in, prod-safe by default):
 *   - venue has no WhatsApp/primary phone   -> no-op
 *   - REMINDERS_LOG_ONLY !== "false"        -> compose + log, DO NOT send (default)
 *   - otherwise                             -> send via utils/venueWhatsApp
 *                                              (Meta Cloud only; no-ops without creds)
 *
 * Never await this on the request path — .catch(() => {}) semantics; the
 * module also swallows its own errors.
 */
const venueWhatsApp = require("./venueWhatsApp");

function ownerPhone(venue) {
  const c = venue.contact || {};
  return (c.whatsappPhone || c.primaryPhone || venue.phone || "").trim();
}

function formatHoldAlert(venue, hold) {
  const days = (hold.dates || []).map((d) => new Date(d).toISOString().slice(0, 10)).join(", ");
  return [
    `New date-hold request for ${venue.name}`,
    `Date(s): ${days}`,
    hold.requestedByName ? `Requested by: ${hold.requestedByName}` : "Requested by: Wedsy concierge",
    hold.notes ? `Notes: ${hold.notes}` : null,
    `Expires: ${new Date(hold.expiresAt).toISOString().slice(0, 10)}`,
    "Approve or decline from your Wedsy Partner calendar.",
  ].filter(Boolean).join("\n");
}

async function notifyHoldRequested(venue, hold) {
  try {
    const phone = ownerPhone(venue);
    if (!phone) return { skipped: "no owner phone" };

    const message = formatHoldAlert(venue, hold);
    const logOnly = process.env.REMINDERS_LOG_ONLY !== "false"; // default true

    if (logOnly) {
      console.log(`[holdAlert][log-only] to=${phone}\n${message}`);
      return { logged: true, message };
    }
    if (!venueWhatsApp.isConfigured()) {
      console.log("[holdAlert] WhatsApp not configured — skipping send");
      return { skipped: "whatsapp unconfigured" };
    }
    const result = await venueWhatsApp.sendText(phone, message);
    if (!result.ok) console.log(`[holdAlert] send failed: ${result.error}`);
    return result;
  } catch (err) {
    console.log(`[holdAlert] error (ignored): ${err.message}`);
    return { ok: false, error: err.message };
  }
}

module.exports = { notifyHoldRequested, formatHoldAlert };
