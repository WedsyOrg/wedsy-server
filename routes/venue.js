const express = require("express");
const router = express.Router();
const { getVenues, getVenueBySlug, updateVenue, createVenue } = require("../controllers/venue");
const { createEnquiry, createManualLead, getVenueEnquiries, updateEnquiry, importLeads, getImports } = require("../controllers/venueEnquiry");
const { saveAvailability } = require("../controllers/venueAvailability");
const { trackView } = require("../controllers/venueView");
const { refreshNearby } = require("../controllers/venueNearby");
const { refreshReviews } = require("../controllers/venueReviews");
const { generateLocationDescription } = require("../controllers/venueLocation");
const { getDashboardOverview } = require("../controllers/venueDashboard");
const { addInteraction, getInteractions } = require("../controllers/venueLeadInteraction");
const { listMembers, inviteMember, updateMember, getActivity } = require("../controllers/venueTeam");
const { venueOwnerAuth } = require("../middlewares/venueOwnerAuth");
const { requireCapability } = require("../middlewares/venueRole");
const { adminOrVenueOwnerAuth } = require("../middlewares/adminOrVenueOwnerAuth");
const { optionalAdminAuth } = require("../middlewares/optionalAdminAuth");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.get("/", optionalAdminAuth, getVenues);
// Admin-only: create a new venue (venue owners must NOT create venues).
router.post("/", CheckAdminLogin, createVenue);
// Venue-owner dashboard home widgets (onboarding, verification, follow-ups).
// Declared before "/:slug" so the literal path is never shadowed by the slug param.
router.get("/dashboard/overview", venueOwnerAuth, getDashboardOverview);
router.get("/:slug", getVenueBySlug);
router.put("/:slug", adminOrVenueOwnerAuth, updateVenue);
router.post("/:slug/enquiry", createEnquiry);
router.post("/:slug/enquiries", createEnquiry);
// Gated manual lead creation (venue owners only) — must precede none, distinct path.
router.post("/:slug/enquiries/manual", venueOwnerAuth, requireCapability("leads"), createManualLead);
// CSV/Excel bulk import + import history. Import writes leads → leads capability;
// imports history is an open read under venueOwnerAuth (capability ruling).
router.post("/:slug/enquiries/import", venueOwnerAuth, requireCapability("leads"), importLeads);
router.get("/:slug/enquiries/imports", venueOwnerAuth, getImports);
router.get("/:slug/enquiries", venueOwnerAuth, getVenueEnquiries); // read: all roles
router.patch("/:slug/enquiries/:enquiryId", venueOwnerAuth, requireCapability("leads"), updateEnquiry);
// Per-lead communication log (4-segment paths — no shadowing of the routes above).
// Logging an interaction is a lead write → leads capability; reading is open.
router.post("/:slug/enquiries/:enquiryId/interactions", venueOwnerAuth, requireCapability("leads"), addInteraction);
router.get("/:slug/enquiries/:enquiryId/interactions", venueOwnerAuth, getInteractions); // open read

// Team members — invite / list / update-deactivate + activity log (team capability).
router.get("/:slug/team", venueOwnerAuth, requireCapability("team"), listMembers);
router.post("/:slug/team", venueOwnerAuth, requireCapability("team"), inviteMember);
router.get("/:slug/team/activity", venueOwnerAuth, requireCapability("team"), getActivity);
router.patch("/:slug/team/:memberId", venueOwnerAuth, requireCapability("team"), updateMember);

router.post("/:slug/availability", venueOwnerAuth, requireCapability("availability"), saveAvailability);
router.post("/:slug/view", CheckLogin, trackView);
router.post("/:slug/nearby", refreshNearby);
router.post("/:slug/reviews", refreshReviews);
router.post("/:slug/generate-location-description", generateLocationDescription);

module.exports = router;
