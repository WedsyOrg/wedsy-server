const express = require("express");
const router = express.Router();
const activity = require("../controllers/activity");
const { CheckAdminLogin } = require("../middlewares/auth");
const { requirePermission } = require("../middlewares/requirePermission");

// Gated settings:view:all so Founder + CRM Admin can view the log.
router.get(
  "/",
  CheckAdminLogin,
  requirePermission("settings:view:all"),
  activity.GetAll
);

module.exports = router;
