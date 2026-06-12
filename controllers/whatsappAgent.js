const crypto = require('crypto');
const { receiveMessage, receiveMedia } = require('../services/WhatsAppAgentService');

const VerifyWebhook = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_AGENT_VERIFY_TOKEN) {
    console.log('[WhatsAppAgent] Webhook verified');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
};

const ReceiveMessage = (req, res) => {
  const signature = req.headers['x-hub-signature-256'];
  if (!signature) {
    console.error('[WhatsAppAgent] Missing signature — request rejected');
    return res.sendStatus(403);
  }

  const expectedSignature = 'sha256=' + crypto
    .createHmac('sha256', process.env.WHATSAPP_AGENT_APP_SECRET)
    .update(req.rawBody || '')
    .digest('hex');

  try {
    const sigBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);
    if (sigBuffer.length !== expectedBuffer.length ||
        !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
      console.error('[WhatsAppAgent] Invalid signature — request rejected');
      return res.sendStatus(403);
    }
  } catch {
    console.error('[WhatsAppAgent] Signature comparison failed');
    return res.sendStatus(403);
  }

  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];
    if (!message) return;
    const phone = message.from;
    // WhatsApp display name travels with the message — used to name the CRM lead.
    const profileName = change?.value?.contacts?.[0]?.profile?.name || '';
    if (message.type === 'text') {
      receiveMessage(phone, message.text.body, { profileName }).catch(err =>
        console.error('[WhatsAppAgent] Unhandled error:', err.message)
      );
    } else {
      // Non-text (image/audio/…): placeholder + conversation bump, no AI reply.
      receiveMedia(phone, message.type, { profileName }).catch(err =>
        console.error('[WhatsAppAgent] Unhandled error:', err.message)
      );
    }
  } catch (error) {
    console.error('[WhatsAppAgent] Webhook parse error:', error.message);
  }
};

module.exports = { VerifyWebhook, ReceiveMessage };
