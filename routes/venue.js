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
const sheets = require("../controllers/venueSheetsSync");
const { venueOwnerAuth } = require("../middlewares/venueOwnerAuth");
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
router.post("/:slug/enquiries/manual", venueOwnerAuth, createManualLead);
// CSV/Excel bulk import + import history (venue owners only).
router.post("/:slug/enquiries/import", venueOwnerAuth, importLeads);
router.get("/:slug/enquiries/imports", venueOwnerAuth, getImports);
router.get("/:slug/enquiries", venueOwnerAuth, getVenueEnquiries);
router.patch("/:slug/enquiries/:enquiryId", venueOwnerAuth, updateEnquiry);
// Per-lead communication log (4-segment paths — no shadowing of the routes above).
router.post("/:slug/enquiries/:enquiryId/interactions", venueOwnerAuth, addInteraction);
router.get("/:slug/enquiries/:enquiryId/interactions", venueOwnerAuth, getInteractions);
// Google Sheets integration (MVP one-way sheet→leads). callback is public — it is
// authorized by the signed OAuth state, since Google's redirect carries no Bearer token.
router.get("/:slug/integrations/google-sheets", venueOwnerAuth, sheets.getIntegration);
router.get("/:slug/integrations/google-sheets/connect", venueOwnerAuth, sheets.connect);
router.get("/:slug/integrations/google-sheets/callback", sheets.callback);
router.post("/:slug/integrations/google-sheets/disconnect", venueOwnerAuth, sheets.disconnect);
router.get("/:slug/integrations/google-sheets/sheets", venueOwnerAuth, sheets.listSheets);
router.post("/:slug/integrations/google-sheets/mapping", venueOwnerAuth, sheets.saveMapping);
router.post("/:slug/integrations/google-sheets/sync", venueOwnerAuth, sheets.syncNow);

router.post("/:slug/availability", venueOwnerAuth, saveAvailability);
router.post("/:slug/view", CheckLogin, trackView);
router.post("/:slug/nearby", refreshNearby);
router.post("/:slug/reviews", refreshReviews);
router.post("/:slug/generate-location-description", generateLocationDescription);

module.exports = router;
