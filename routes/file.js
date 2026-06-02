const express = require("express");
const router = express.Router();
const fileUpload = require("express-fileupload");

const { CheckLogin } = require("../middlewares/auth");
const { venueOwnerAuth } = require("../middlewares/venueOwnerAuth");
const { adminOrVenueOwnerAuth } = require("../middlewares/adminOrVenueOwnerAuth");
const file = require("../controllers/file");

router.post("/", CheckLogin, fileUpload({ parseNested: true }), file.CreateNew);
router.post("/upload", adminOrVenueOwnerAuth, file.VenueOwnerUpload);

module.exports = router;
