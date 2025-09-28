const express = require("express");
const router = express.Router();

const { CheckLogin } = require("../middlewares/auth");
const auth = require("../controllers/auth");

// Admin Auth
router.post("/admin", auth.AdminLogin);
router.get("/admin", CheckLogin, auth.GetAdmin);

// Vendor Auth
router.post("/vendor", auth.VendorLogin);
router.get("/vendor", CheckLogin, auth.GetVendor);

// User Auth
router.post("/", auth.Login);
router.get("/", CheckLogin, auth.Get);
router.post("/otp", auth.GetOTP);

module.exports = router;
