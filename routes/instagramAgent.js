const express = require('express');
const router = express.Router();
const { VerifyWebhook, ReceiveMessage } = require('../controllers/instagramAgent');

router.get('/instagram-agent', VerifyWebhook);
router.post('/instagram-agent', ReceiveMessage);

module.exports = router;
