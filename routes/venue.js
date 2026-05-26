const express = require("express");
const router = express.Router();
const { getVenues, getVenueBySlug, updateVenue } = require("../controllers/venue");
const { createEnquiry, getVenueEnquiries, updateEnquiry } = require("../controllers/venueEnquiry");
const { saveAvailability } = require("../controllers/venueAvailability");
const { trackView } = require("../controllers/venueView");
const { venueOwnerAuth } = require("../middlewares/venueOwnerAuth");
const { CheckLogin } = require("../middlewares/auth");

router.get("/", getVenues);
router.get("/:slug", getVenueBySlug);
router.put("/:slug", venueOwnerAuth, updateVenue);
router.post("/:slug/enquiry", createEnquiry);
router.post("/:slug/enquiries", createEnquiry);
router.get("/:slug/enquiries", venueOwnerAuth, getVenueEnquiries);
router.patch("/:slug/enquiries/:enquiryId", venueOwnerAuth, updateEnquiry);
router.post("/:slug/availability", venueOwnerAuth, saveAvailability);
router.post("/:slug/view", CheckLogin, trackView);

module.exports = router;
