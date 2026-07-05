const express = require("express");
const router = express.Router();

const ops = require("../controllers/adminVenueOps");
const queues = require("../controllers/adminVenueQueues");
const availability = require("../controllers/adminVenueAvailability");
const leads = require("../controllers/adminVenueLeads");
const planner = require("../controllers/adminVenuePlanner");
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

// P0 S4 (D1 bridge) — cross-venue leads oversight (read-only) + the explicit
// "Forward to Sales CRM" action (venue-owned VenueForwardRequest; the CRM
// receive side is OS's build).
router.get("/leads", CheckAdminLogin, leads.listLeads);
router.post("/leads/:enquiryId/forward", CheckAdminLogin, leads.forwardLead);
router.get("/forwards", CheckAdminLogin, leads.listForwards);

// P0 S5 (D10) — cross-venue high-severity firehose (severity=all opts out).
router.get("/activity-feed", CheckAdminLogin, ops.activityFirehose);

// P1 — Lead Planner: shortlists (venue-owned, one per CRM lead), present-link
// management, one-tap hold + site visit (both run the D2 linkage), and
// site-visit oversight. Public present-mode reads live under /venues/present.
router.post("/shortlists", CheckAdminLogin, planner.createShortlist);
router.get("/shortlists", CheckAdminLogin, planner.listShortlists);
router.get("/shortlists/:id", CheckAdminLogin, planner.getShortlist);
router.post("/shortlists/:id/items", CheckAdminLogin, planner.addItem);
router.patch("/shortlists/:id/items/:itemId", CheckAdminLogin, planner.updateItem);
router.delete("/shortlists/:id/items/:itemId", CheckAdminLogin, planner.removeItem);
router.post("/shortlists/:id/present-link", CheckAdminLogin, planner.generatePresentLink);
router.post("/shortlists/:id/items/:itemId/hold", CheckAdminLogin, planner.requestItemHold);
router.post("/shortlists/:id/items/:itemId/visit", CheckAdminLogin, planner.scheduleItemVisit);
router.get("/site-visits", CheckAdminLogin, planner.listSiteVisits);
router.patch("/site-visits/:visitId", CheckAdminLogin, planner.updateSiteVisit);

router.get("/:slug/summary", CheckAdminLogin, ops.venueSummary);
router.get("/:slug/enquiries", CheckAdminLogin, ops.listVenueEnquiries);
router.get("/:slug/activity", CheckAdminLogin, ops.listVenueActivity);

module.exports = router;
