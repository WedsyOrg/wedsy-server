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

module.exports = { VerifyWebhook, ReceiveMessage };
