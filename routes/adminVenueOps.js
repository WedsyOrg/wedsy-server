const express = require("express");
const router = express.Router();

const ops = require("../controllers/adminVenueOps");
const { CheckAdminLogin } = require("../middlewares/auth");

// MB-V2 P0 — Wedsy-internal venue workspace (Wedsy OS "Venues" module).
// All operational venue data (not admin/user management), so these are
// CheckAdminLogin-only — the same classification as the venue-journey reads
// in routes/admin.js. Every route here MUST stay admin-gated: owner/member
// venue tokens are rejected by CheckAdminLogin (no isAdmin claim).
router.get("/", CheckAdminLogin, ops.directory);
router.get("/:slug/summary", CheckAdminLogin, ops.venueSummary);
router.get("/:slug/enquiries", CheckAdminLogin, ops.listVenueEnquiries);
router.get("/:slug/activity", CheckAdminLogin, ops.listVenueActivity);

module.exports = router;
