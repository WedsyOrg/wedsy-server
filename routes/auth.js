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

// User management (admin)
router.put("/user/block", CheckLogin, auth.BlockUser);
router.delete("/user", CheckLogin, auth.DeleteUserAccount);
router.put("/user/restore", CheckLogin, auth.RestoreUserAccount);

// Vendor account management
// Vendor can delete own account, Admin can delete any vendor
router.delete("/vendor", CheckLogin, auth.DeleteVendorAccount);
// Only admin can restore vendor account
router.put("/vendor/restore", CheckLogin, auth.RestoreVendorAccount);

module.exports = router;
