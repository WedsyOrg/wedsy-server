/**
 * utils/venueOpsAlert.js — fire-and-forget WhatsApp alert to the Wedsy ops
 * phone when a venue submits a "list your venue" onboarding request.
 *
 * Gating (all opt-in, prod-safe by default):
 *   - OPS_ALERT_PHONE unset            -> no-op
 *   - REMINDERS_LOG_ONLY !== "false"   -> compose + log, DO NOT send (default)
 *   - otherwise                        -> send via utils/venueWhatsApp (Meta
 *                                         Cloud only; no-ops without creds)
 *
 * Callers must never await delivery on the request path — use
 * notifyOnboardingRequest(...).catch(() => {}) semantics; this module also
 * swallows its own errors so a notification can never break the request.
 */
const venueWhatsApp = require("./venueWhatsApp");

function formatOnboardingAlert({ name, venueName, city, phone }) {
  return [
    "New venue onboarding request",
    `Venue: ${venueName}`,
    `Contact: ${name} · ${phone}`,
    `City: ${city || "—"}`,
    "Follow up from the Wedsy OS leads view.",
  ].join("\n");
}

async function notifyOnboardingRequest(request) {
  try {
    const opsPhone = (process.env.OPS_ALERT_PHONE || "").trim();
    if (!opsPhone) return { skipped: "no OPS_ALERT_PHONE" };

    const message = formatOnboardingAlert(request);
    const logOnly = process.env.REMINDERS_LOG_ONLY !== "false"; // default true

    if (logOnly) {
      console.log(`[opsAlert][log-only] to=${opsPhone}\n${message}`);
      return { logged: true, message };
    }
    if (!venueWhatsApp.isConfigured()) {
      console.log("[opsAlert] WhatsApp not configured — skipping send");
      return { skipped: "whatsapp unconfigured" };
    }
    const result = await venueWhatsApp.sendText(opsPhone, message);
    if (!result.ok) console.log(`[opsAlert] send failed: ${result.error}`);
    return result;
  } catch (err) {
    console.log(`[opsAlert] error (ignored): ${err.message}`);
    return { ok: false, error: err.message };
  }
}

module.exports = { notifyOnboardingRequest, formatOnboardingAlert };
