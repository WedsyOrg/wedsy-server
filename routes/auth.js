const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");

const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");
const auth = require("../controllers/auth");
const authInternational = require("../controllers/auth.international");

// Admin Auth
// Login keeps a strict budget (20/15min/IP) so raising the general limiter
// for chat polling doesn't loosen brute-force protection. Same localhost
// skip as the general limiter so local e2e runs aren't throttled.
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip),
});
router.post("/admin", adminLoginLimiter, auth.AdminLogin);
router.get("/admin", CheckLogin, auth.GetAdmin);
// Settings Suite: resolved permissions for the caller (drives Settings UI visibility).
router.get("/admin/permissions", CheckAdminLogin, auth.GetPermissions);
// Password reset (Lifecycle Slice G). Forgot is rate-limited (5/hour/IP) and
// always answers generically — no user enumeration.
const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
});
router.post("/admin/forgot", forgotLimiter, auth.ForgotPassword);
router.post("/admin/reset", auth.ResetPassword);
// Forced first-login password change (Settings Suite Slice 9).
router.post("/admin/first-reset", CheckAdminLogin, auth.FirstResetPassword);

// Vendor Auth
router.post("/vendor", auth.VendorLogin);
router.get("/vendor", CheckLogin, auth.GetVendor);

// User Auth
router.post("/", auth.Login);
router.get("/", CheckLogin, auth.Get);
router.post("/otp", auth.GetOTP);
router.post("/otp/international", authInternational.SendInternationalOTP);
router.post("/verify/international", authInternational.VerifyInternationalOTP);
router.post("/signup/international", authInternational.SignupInternational);

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
