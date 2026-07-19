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

// L1 — the ACTIVITY INGEST seam: admin JWT or the wedsy-user service secret
// (x-internal-secret, env INTERNAL_INGEST_SECRET — fail-closed while unset).
const { InternalOrAdmin } = require("../middlewares/internalAuth");
const leadPageV3 = require("../controllers/leadPageV3");
router.post("/ingest", InternalOrAdmin, leadPageV3.IngestActivity);

module.exports = router;
