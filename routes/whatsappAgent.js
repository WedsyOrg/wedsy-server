const express = require('express');
const router = express.Router();
const { receiveMessage } = require('../services/WhatsAppAgentService');

// Meta webhook verification
router.get('/whatsapp-agent', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_AGENT_VERIFY_TOKEN) {
    console.log('[WhatsAppAgent] Webhook verified');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Receive inbound WhatsApp messages
router.post('/whatsapp-agent', (req, res) => {
  // Always respond 200 immediately — Meta requires fast response
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];

    if (!message || message.type !== 'text') return;

    const phone = message.from;
    const text = message.text.body;

    // Fire and forget — do not await
    receiveMessage(phone, text).catch(err =>
      console.error('[WhatsAppAgent] Unhandled error:', err.message)
    );
  } catch (err) {
    console.error('[WhatsAppAgent] Webhook parse error:', err.message);
  }
});

module.exports = router;
