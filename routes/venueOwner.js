const express = require("express");
const router = express.Router();
const { getClaimInfo, initiateClaim, verifyClaim, verifyDocument, submitManualClaim, sendLoginOTP, login } = require("../controllers/venueOwner");

router.get("/claim-info/:slug", getClaimInfo);
router.post("/claim", initiateClaim);
router.post("/claim/verify", verifyClaim);
router.post("/claim/document", verifyDocument);
router.post("/claim/manual", submitManualClaim);
router.post("/auth/send-otp", sendLoginOTP);
router.post("/auth", login);

module.exports = router;
