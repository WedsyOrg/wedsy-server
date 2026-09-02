// Admin-facing Instagram agent surface (mounted at /instagram-agent).
// Separate file from instagramAgent.js deliberately: that router is the
// unauthenticated Meta WEBHOOK (mounted under /webhook, signature-verified);
// this one is the CRM's own authed read side. Mixing them would put
// CheckAdminLogin in front of Meta's webhook or webhook paths under /instagram-agent.
const express = require("express");
const router = express.Router();
const { CheckAdminLogin } = require("../middlewares/auth");
const { ConnectedAccount } = require("../controllers/instagramAgent");

router.get("/connected-account", CheckAdminLogin, ConnectedAccount);

module.exports = router;
