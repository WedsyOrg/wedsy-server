const express = require("express");
const router = express.Router();
const { getVenues, getVenueBySlug, updateVenue } = require("../controllers/venue");
const { createEnquiry, getVenueEnquiries } = require("../controllers/venueEnquiry");
const { saveAvailability } = require("../controllers/venueAvailability");
const { venueOwnerAuth } = require("../middlewares/venueOwnerAuth");

router.get("/", getVenues);
router.get("/:slug", getVenueBySlug);
router.put("/:slug", venueOwnerAuth, updateVenue);
router.post("/:slug/enquiry", createEnquiry);
router.get("/:slug/enquiries", venueOwnerAuth, getVenueEnquiries);
router.post("/:slug/availability", venueOwnerAuth, saveAvailability);

module.exports = router;
