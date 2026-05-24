const { receiveMessage } = require('../services/InstagramAgentService');

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
  res.sendStatus(200);
  try {
    const entry = req.body?.entry?.[0];
    const messaging = entry?.messaging?.[0];
    if (!messaging || !messaging.message || messaging.message.is_echo) return;
    const senderId = messaging.sender.id;
    const text = messaging.message.text;
    if (!text) return;
    receiveMessage(senderId, text).catch(err =>
      console.error('[InstagramAgent] Unhandled error:', err.message)
    );
  } catch (error) {
    console.error('[InstagramAgent] Webhook parse error:', error.message);
  }
};

module.exports = { VerifyWebhook, ReceiveMessage };
