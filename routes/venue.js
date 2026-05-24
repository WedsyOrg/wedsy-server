const express = require("express");
const router = express.Router();
const { getVenues, getVenueBySlug } = require("../controllers/venue");
const { createEnquiry } = require("../controllers/venueEnquiry");

router.get("/", getVenues);
router.get("/:slug", getVenueBySlug);
router.post("/:slug/enquiry", createEnquiry);

module.exports = router;
