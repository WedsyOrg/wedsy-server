const express = require("express");
const router = express.Router();

const ops = require("../controllers/adminVenueOps");
const queues = require("../controllers/adminVenueQueues");
const availability = require("../controllers/adminVenueAvailability");
const { CheckAdminLogin } = require("../middlewares/auth");

// MB-V2 P0 — Wedsy-internal venue workspace (Wedsy OS "Venues" module).
// All operational venue data (not admin/user management), so these are
// CheckAdminLogin-only — the same classification as the venue-journey reads
// in routes/admin.js. Every route here MUST stay admin-gated: owner/member
// venue tokens are rejected by CheckAdminLogin (no isAdmin claim).
router.get("/", CheckAdminLogin, ops.directory);

// P0 S2 (D11) — queues. Literal paths stay ABOVE the /:slug param routes.
router.get("/claims", CheckAdminLogin, queues.listClaims);
router.get("/claims/:id", CheckAdminLogin, queues.getClaim);
router.post("/claims/:id/approve", CheckAdminLogin, queues.approveClaim);
router.post("/claims/:id/reject", CheckAdminLogin, queues.rejectClaim);
router.get("/onboarding-requests", CheckAdminLogin, queues.listOnboardingRequests);
router.patch("/onboarding-requests/:id", CheckAdminLogin, queues.updateOnboardingRequest);
router.get("/partner-board", CheckAdminLogin, queues.partnerBoard);

// P0 S3 (E2 admin side) — read-only day-board + cross-venue hold tracker.
// Hold REQUESTS go through the existing POST /venues/:slug/holds (admin
// token); approve/decline/release/convert stay owner-only per D3.
router.get("/day-board", CheckAdminLogin, availability.dayBoard);
router.get("/holds", CheckAdminLogin, availability.listHoldsAdmin);

router.get("/:slug/summary", CheckAdminLogin, ops.venueSummary);
router.get("/:slug/enquiries", CheckAdminLogin, ops.listVenueEnquiries);
router.get("/:slug/activity", CheckAdminLogin, ops.listVenueActivity);

module.exports = router;
