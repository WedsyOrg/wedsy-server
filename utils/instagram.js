const NotificationFailureLog = require('../models/NotificationFailureLog');

// Mock seam (MB6 Slice 7) — same idiom as META_GRAPH_BASE_URL in utils/whatsapp.
const IG_GRAPH_BASE_URL = process.env.INSTAGRAM_GRAPH_BASE_URL || 'https://graph.instagram.com/v25.0';

const sendInstagramDM = async (recipientId, message) => {
  const MAX_RETRIES = 2;
  let attempt = 0;

  while (attempt <= MAX_RETRIES) {
    try {
      const response = await fetch(
        `${IG_GRAPH_BASE_URL}/me/messages`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.INSTAGRAM_AGENT_PAGE_ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            recipient: { id: recipientId },
            message: { text: message }
          })
        }
      );
      if (!response.ok) throw new Error(`Instagram API error: ${response.status}`);
      return await response.json();
    } catch (error) {
      attempt++;
      if (attempt > MAX_RETRIES) {
        try {
          await NotificationFailureLog.create({
            service: 'Instagram',
            phone: recipientId,
            error: error.message,
            attempts: attempt,
            createdAt: new Date()
          });
        } catch (logErr) {
          console.error('[Instagram] Failed to log failure:', logErr.message);
        }
        console.error(`[Instagram] Failed after ${attempt} attempts:`, error.message);
        return null;
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
};

// Fetch an Instagram user's display name/username via the Graph API. The IG
// message webhook carries only the scoped user id (no name), unlike WhatsApp —
// so the name needs this separate lookup. Mirrors sendInstagramDM (same base
// URL + page token + INSTAGRAM_GRAPH_BASE_URL test seam). Fire-safe: returns ""
// on any failure so the inbound flow never breaks on a missing name.
const fetchInstagramProfile = async (igsid) => {
  try {
    const response = await fetch(
      `${IG_GRAPH_BASE_URL}/${igsid}?fields=name,username`,
      { headers: { Authorization: `Bearer ${process.env.INSTAGRAM_AGENT_PAGE_ACCESS_TOKEN}` } }
    );
    if (!response.ok) return "";
    const data = await response.json();
    return (data && (data.name || data.username)) || "";
  } catch (error) {
    console.error("[Instagram] profile fetch failed:", error.message);
    return "";
  }
};

module.exports = { sendInstagramDM, fetchInstagramProfile };
