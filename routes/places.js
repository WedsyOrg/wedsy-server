const express = require("express");
const router = express.Router();
const { Autocomplete, Details } = require("../controllers/places");
const { adminOrVenueOwnerAuth } = require("../middlewares/adminOrVenueOwnerAuth");

router.get("/autocomplete", adminOrVenueOwnerAuth, Autocomplete);
router.get("/details", adminOrVenueOwnerAuth, Details);

module.exports = router;
