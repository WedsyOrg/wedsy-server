const express = require("express");
const router = express.Router();
const fileUpload = require("express-fileupload");

const { CheckLogin } = require("../middlewares/auth");
const { venueOwnerAuth } = require("../middlewares/venueOwnerAuth");
const file = require("../controllers/file");

router.post("/", CheckLogin, fileUpload({ parseNested: true }), file.CreateNew);
router.post("/upload", venueOwnerAuth, file.VenueOwnerUpload);

module.exports = router;
