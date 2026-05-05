const express = require("express");
const router = express.Router();
const fileUpload = require("express-fileupload");

const vendorAuth = require("../../controllers/vendor/auth");
const vendorAuthInternational = require("../../controllers/vendor/auth.international");

// Vendor auth (OTP-based)
router.post("/otp", vendorAuth.sendOtp);
router.post("/login", vendorAuth.login);
router.post("/signup", fileUpload({ parseNested: true }), vendorAuth.signup);
router.post("/otp/international", vendorAuthInternational.sendInternationalOtp);
router.post("/verify/international", vendorAuthInternational.verifyInternationalOtp);

module.exports = router;

