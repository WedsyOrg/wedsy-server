const express = require('express');
const router = express.Router();
const { VerifyWebhook, ReceiveMessage } = require('../controllers/whatsappAgent');

router.get('/whatsapp-agent', VerifyWebhook);
router.post('/whatsapp-agent', ReceiveMessage);

module.exports = router;
