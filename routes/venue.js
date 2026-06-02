const express = require("express");
const router = express.Router();
const { getVenues, getVenueBySlug, updateVenue } = require("../controllers/venue");
const { createEnquiry, getVenueEnquiries, updateEnquiry } = require("../controllers/venueEnquiry");
const { saveAvailability } = require("../controllers/venueAvailability");
const { trackView } = require("../controllers/venueView");
const { refreshNearby } = require("../controllers/venueNearby");
const { refreshReviews } = require("../controllers/venueReviews");
const { generateLocationDescription } = require("../controllers/venueLocation");
const { venueOwnerAuth } = require("../middlewares/venueOwnerAuth");
const { adminOrVenueOwnerAuth } = require("../middlewares/adminOrVenueOwnerAuth");
const { optionalAdminAuth } = require("../middlewares/optionalAdminAuth");
const { CheckLogin } = require("../middlewares/auth");

router.get("/", optionalAdminAuth, getVenues);
router.get("/:slug", getVenueBySlug);
router.put("/:slug", adminOrVenueOwnerAuth, updateVenue);
router.post("/:slug/enquiry", createEnquiry);
router.post("/:slug/enquiries", createEnquiry);
router.get("/:slug/enquiries", venueOwnerAuth, getVenueEnquiries);
router.patch("/:slug/enquiries/:enquiryId", venueOwnerAuth, updateEnquiry);
router.post("/:slug/availability", venueOwnerAuth, saveAvailability);
router.post("/:slug/view", CheckLogin, trackView);
router.post("/:slug/nearby", refreshNearby);
router.post("/:slug/reviews", refreshReviews);
router.post("/:slug/generate-location-description", generateLocationDescription);

module.exports = router;
