const express = require("express");
const router = express.Router();
const { initiateClaim, verifyClaim, login, sendLoginOTP } = require("../controllers/venueOwner");

router.post("/claim", initiateClaim);
router.post("/claim/verify", verifyClaim);
router.post("/auth/send-otp", sendLoginOTP);
router.post("/auth", login);

module.exports = router;
