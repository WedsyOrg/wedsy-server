const express = require("express");
const router = express.Router();
const { getVenues, getVenueBySlug } = require("../controllers/venue");

router.get("/", getVenues);
router.get("/:slug", getVenueBySlug);

module.exports = router;
