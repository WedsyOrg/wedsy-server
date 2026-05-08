const { receiveMessage } = require('../services/WhatsAppAgentService');

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
  res.sendStatus(200);
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];
    if (!message || message.type !== 'text') return;
    const phone = message.from;
    const text = message.text.body;
    receiveMessage(phone, text).catch(err =>
      console.error('[WhatsAppAgent] Unhandled error:', err.message)
    );
  } catch (error) {
    console.error('[WhatsAppAgent] Webhook parse error:', error.message);
  }
};

module.exports = { VerifyWebhook, ReceiveMessage };
