const express = require("express");
const router = express.Router();

const vendorReview = require("../controllers/vendor-review");
const { CheckLogin, CheckToken, CheckVendorLogin, CheckAdminLogin } = require("../middlewares/auth");

// Public read APIs for user app (no login required)
router.get("/public", vendorReview.PublicList);
router.get("/public/stats", vendorReview.PublicStats);

// Public review submission via share link (optional auth)
router.post("/public", CheckToken, vendorReview.CreatePublic);

// Vendor/Admin review share links
router.get("/share", CheckLogin, vendorReview.ListShares);
router.post("/share", CheckLogin, vendorReview.CreateShare);
router.delete("/share/:shareId", CheckLogin, vendorReview.RevokeShare);

// Vendor/Admin listing + stats
router.get("/", CheckLogin, vendorReview.List);
router.get("/stats", CheckLogin, vendorReview.Stats);

// User-auth create (optional direct flow)
router.post("/", CheckLogin, vendorReview.Create);

// Vendor/Admin reply
router.put("/:_id/reply", CheckLogin, vendorReview.Reply);

// Reactions (user/vendor/admin)
router.post("/:_id/reaction", CheckLogin, vendorReview.React);

module.exports = router;


