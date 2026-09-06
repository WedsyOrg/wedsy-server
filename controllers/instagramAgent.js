const crypto = require('crypto');
const { receiveMessage, receiveAttachment } = require('../services/InstagramAgentService');

const VerifyWebhook = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.INSTAGRAM_AGENT_VERIFY_TOKEN) {
    console.log('[InstagramAgent] Webhook verified');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
};

const ReceiveMessage = (req, res) => {
  const signature = req.headers['x-hub-signature-256'];
  if (!signature) {
    console.error('[InstagramAgent] Missing signature — request rejected');
    return res.sendStatus(403);
  }

  const expectedSignature = 'sha256=' + crypto
    .createHmac('sha256', process.env.INSTAGRAM_AGENT_APP_SECRET)
    .update(req.rawBody || '')
    .digest('hex');

  try {
    const sigBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);
    if (sigBuffer.length !== expectedBuffer.length ||
        !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
      console.error('[InstagramAgent] Invalid signature — request rejected');
      return res.sendStatus(403);
    }
  } catch {
    console.error('[InstagramAgent] Signature comparison failed');
    return res.sendStatus(403);
  }

  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const messaging = entry?.messaging?.[0];
    if (!messaging || !messaging.message || messaging.message.is_echo) return;
    const senderId = messaging.sender.id;
    const text = messaging.message.text;
    if (text) {
      receiveMessage(senderId, text).catch(err =>
        console.error('[InstagramAgent] Unhandled error:', err.message)
      );
      return;
    }
    // Inbound attachments (image/video/audio/file): download + store each,
    // mirroring the WhatsApp media path. Previously these were silently dropped.
    const attachments = messaging.message.attachments;
    if (Array.isArray(attachments)) {
      for (const attachment of attachments) {
        receiveAttachment(senderId, attachment).catch(err =>
          console.error('[InstagramAgent] Unhandled error:', err.message)
        );
      }
    }
  } catch (error) {
    console.error('[InstagramAgent] Webhook parse error:', error.message);
  }
};

// GET /instagram-agent/connected-account — the connected IG professional
// account's own profile, for the inbox header (Meta app review requires the
// permission to be seen doing visible work). Contract: a missing/expired token
// or any upstream failure is a CLEAN { connected: false } with HTTP 200 —
// never a 500 — so the UI can render "Not connected" instead of an error.
// profilePictureUrl is re-fetched every call (short-lived CDN URL, never cached).
//
// ── THREE STATES, NOT TWO (6 Sep 2026) ──────────────────────────────────────
//   source: "database"     an ACTIVE row exists — genuinely connected
//   source: "env_fallback" no active row, but INSTAGRAM_AGENT_PAGE_ACCESS_TOKEN
//                          still works. DEGRADED: sending works, but nothing in
//                          the database vouches for it and no OAuth grant backs
//                          it. `connected` is FALSE here.
//   source: "none"         neither
//
// This endpoint previously reported connected:true for the fallback, because it
// inferred a connection from Graph answering — and Graph answers for the env
// token too. Production sat in exactly that state with both rows revoked: the
// panel said @wedsy.in was connected, Disconnect appeared to succeed and changed
// nothing (a second click 404d), and Connect never rendered, so there was no way
// out of the state and no way to record the OAuth round trip Meta asks for.
//
// The env fallback exists to keep Kiara SENDING across one deploy. It was never
// evidence that an account is connected, and it must not read as one.
//
// `connected` therefore means exactly one thing: an active row exists. The
// username/id/avatar are still returned in the fallback state, deliberately —
// an operator needs to see WHOSE token is running before replacing it.
//
// THE MODEL IS THE SOURCE OF TRUTH for *who* is connected: identity comes from
// ConnectedInstagramAccount, not from .env and not from the network. Graph is
// consulted only for the one field we are forbidden to store — the short-lived
// profile picture URL — so an upstream blip downgrades the avatar rather than
// blanking the header and making a live connection look dead to a reviewer.
const ConnectedAccount = async (req, res) => {
  try {
    const ConnectedInstagramAccount = require('../models/ConnectedInstagramAccount');
    const { fetchConnectedInstagramAccount } = require('../utils/instagram');

    // THE ONLY THING THAT MAKES US "CONNECTED" IS AN ACTIVE ROW.
    const stored = await ConnectedInstagramAccount.findOne({ status: 'active' })
      .sort({ updatedAt: -1 })
      .lean();

    // Graph answers whenever ANY usable token exists — including the env
    // bootstrap fallback, which resolveAccessToken() returns when there is no
    // active row. So a live profile proves a token works; it does NOT prove an
    // account is connected. Conflating the two is the bug this fixes.
    const live = await fetchConnectedInstagramAccount();

    const source = stored ? 'database' : live ? 'env_fallback' : 'none';

    return res.status(200).json({
      id: (stored && stored.instagramUserId) || (live && live.id) || null,
      username: (stored && stored.username) || (live && live.username) || null,
      profilePictureUrl: (live && live.profilePictureUrl) || null,
      // Strictly "an active ConnectedInstagramAccount row exists". Nothing else.
      connected: source === 'database',
      // Which of the three states this is, so the panel can act rather than guess.
      source,
      // Running, but on a token nothing in the database vouches for.
      degraded: source === 'env_fallback',
    });
  } catch (error) {
    console.error('[InstagramAgent] connected-account error:', error.message);
    // Claim no source we cannot prove.
    return res.status(200).json({
      id: null, username: null, profilePictureUrl: null,
      connected: false, source: 'none', degraded: false,
    });
  }
};

module.exports = { VerifyWebhook, ReceiveMessage, ConnectedAccount };
