const express = require("express");
const router = express.Router();
const { getClaimInfo, initiateClaim, verifyClaim, verifyDocument, submitManualClaim, sendLoginOTP, login, memberLogin, selectIdentity, myVenues, switchVenue, portfolioOverview } = require("../controllers/venueOwner");
const { venueOwnerAuth } = require("../middlewares/venueOwnerAuth");
const { memberAuthLimiter } = require("../utils/venueEnquiryRateLimit");

router.get("/claim-info/:slug", getClaimInfo);
router.post("/claim", initiateClaim);
router.post("/claim/verify", verifyClaim);
router.post("/claim/document", verifyDocument);
router.post("/claim/manual", submitManualClaim);
router.post("/auth/send-otp", sendLoginOTP);
router.post("/auth", login);
// RBAC v2 (D5): member email+password login — own rate-limit bucket; owner
// auth stays phone OTP above.
router.post("/member-auth", memberAuthLimiter, memberLogin);
// Multi-identity disambiguation: exchange a selection token + chosen identity
// for the venue_owner session token.
router.post("/auth/select-identity", selectIdentity);

// ── Multi-property (one owner, many venues) — all venueOwnerAuth, phone +
//    identities re-resolved from DB inside each handler ──
router.get("/my-venues", venueOwnerAuth, myVenues);
router.post("/switch-venue", venueOwnerAuth, switchVenue);
router.get("/portfolio/overview", venueOwnerAuth, portfolioOverview);

module.exports = router;
