const express = require("express");
const router = express.Router();
const fileUpload = require("express-fileupload");

const vendorAuth = require("../../controllers/vendor/auth");

// Vendor auth (OTP-based)
router.post("/otp", vendorAuth.sendOtp);
router.post("/login", vendorAuth.login);
router.post("/signup", fileUpload({ parseNested: true }), vendorAuth.signup);

module.exports = router;

