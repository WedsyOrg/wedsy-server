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

// The connected Instagram professional account's own profile (Meta app review:
// the inbox must render "username, profile pic or other profile information" of
// the connected account, so the reviewer sees the permission doing visible work).
//
// This base URL is graph.instagram.com (Instagram Login surface), so /me IS the
// Instagram account — but its `id` is app-scoped; `user_id` is the real
// Instagram account id, so that is what callers get as `id`.
//
// profile_picture_url is a short-lived Meta CDN URL: callers must NOT persist
// it (it silently expires — during Meta's review, not ours). Re-fetch per call.
// Same idiom as sendInstagramDM: 2 retries, failure to NotificationFailureLog.
const fetchConnectedInstagramAccount = async () => {
  const token = process.env.INSTAGRAM_AGENT_PAGE_ACCESS_TOKEN;
  if (!token) return null; // unconfigured — no network call, no retry, no log spam

  const MAX_RETRIES = 2;
  let attempt = 0;

  while (attempt <= MAX_RETRIES) {
    try {
      const response = await fetch(
        `${IG_GRAPH_BASE_URL}/me?fields=user_id,username,profile_picture_url`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!response.ok) throw new Error(`Instagram API error: ${response.status}`);
      const data = await response.json();
      if (!data || !data.username) throw new Error('Instagram API error: no username in /me response');
      return {
        id: String(data.user_id || data.id || ''),
        username: data.username,
        profilePictureUrl: data.profile_picture_url || '',
      };
    } catch (error) {
      attempt++;
      if (attempt > MAX_RETRIES) {
        try {
          await NotificationFailureLog.create({
            service: 'Instagram',
            template: 'connected-account',
            error: error.message,
            attempts: attempt,
            createdAt: new Date()
          });
        } catch (logErr) {
          console.error('[Instagram] Failed to log failure:', logErr.message);
        }
        console.error(`[Instagram] connected-account fetch failed after ${attempt} attempts:`, error.message);
        return null;
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
};

module.exports = { sendInstagramDM, fetchInstagramProfile, fetchConnectedInstagramAccount };
