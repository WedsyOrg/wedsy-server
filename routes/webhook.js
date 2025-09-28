const express = require("express");
const router = express.Router();

const webhook = require("../controllers/webhook");

router.post("/ad-leads", webhook.CreateNewAdsLead);

module.exports = router;
