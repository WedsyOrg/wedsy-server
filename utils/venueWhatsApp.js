/**
 * utils/venueWhatsApp.js
 *
 * Thin Meta WhatsApp Cloud API helper for venue dashboard outbound messages.
 * Meta Cloud API ONLY (graph.facebook.com) — never Aisensy.
 *
 * Env (preferred names per spec, with fallback to the existing server vars):
 *   WHATSAPP_CLOUD_TOKEN      (fallback META_WA_ACCESS_TOKEN)
 *   WHATSAPP_PHONE_NUMBER_ID  (fallback META_WA_PHONE_NUMBER_ID)
 *
 * If neither token+phoneId is present, isConfigured() === false and callers
 * must respond 503 { configured: false } rather than attempting a send. Sends
 * never throw to the caller — failures resolve to { ok: false, error }.
 */
const axios = require("axios");

const GRAPH_VERSION = "v19.0";

function getCreds() {
  const token = process.env.WHATSAPP_CLOUD_TOKEN || process.env.META_WA_ACCESS_TOKEN || "";
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.META_WA_PHONE_NUMBER_ID || "";
  return { token, phoneNumberId };
}

function isConfigured() {
  const { token, phoneNumberId } = getCreds();
  return Boolean(token && phoneNumberId);
}

/**
 * Send a plain text WhatsApp message via the Cloud API.
 * Returns { ok: true, id } on success or { ok: false, error } on failure.
 * Never throws.
 */
async function sendText(phone, message) {
  const { token, phoneNumberId } = getCreds();
  if (!token || !phoneNumberId) {
    return { ok: false, error: "not_configured" };
  }
  const to = String(phone || "").replace(/\D/g, "");
  if (!to) return { ok: false, error: "invalid_phone" };
  try {
    const res = await axios.post(
      `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: String(message || "") },
      },
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, timeout: 15000 }
    );
    const id = res.data && res.data.messages && res.data.messages[0] && res.data.messages[0].id;
    return { ok: true, id: id || null };
  } catch (err) {
    const detail = err.response && err.response.data ? JSON.stringify(err.response.data) : err.message;
    return { ok: false, error: detail };
  }
}

module.exports = { isConfigured, sendText };
