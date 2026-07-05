const express = require("express");
const router = express.Router();

const present = require("../controllers/venuePresent");
const { publicReadLimiter } = require("../utils/venueEnquiryRateLimit");

// MB-V2 P1 — PUBLIC present-mode (couple opens a shared shortlist link).
// The 48-hex token is the credential: typed in the controller, rotated on
// every regenerate, and both routes sit behind the shared public read
// limiter. Mounted at /venues/present ABOVE /venues so venue.js's public
// :slug routes never see these paths.
router.get("/:token", publicReadLimiter, present.getPresentation);
router.post("/:token/react", publicReadLimiter, present.react);

module.exports = router;
