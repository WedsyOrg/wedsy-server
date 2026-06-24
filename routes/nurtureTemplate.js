const express = require("express");
const router = express.Router();

const nurture = require("../controllers/nurture");
const { CheckAdminLogin } = require("../middlewares/auth");
const { requirePermission } = require("../middlewares/requirePermission");

// MB7b Slice 4 — the Nurture Library. Reads are open to any admin (CS picks
// copy-paste text); writes are founder-gated (settings_nurture).
router.get("/", CheckAdminLogin, nurture.ListTemplates);
router.post(
  "/",
  CheckAdminLogin,
  requirePermission("settings_nurture:edit:all"),
  nurture.CreateTemplate
);
router.put(
  "/:_id",
  CheckAdminLogin,
  requirePermission("settings_nurture:edit:all"),
  nurture.UpdateTemplate
);
router.delete(
  "/:_id",
  CheckAdminLogin,
  requirePermission("settings_nurture:edit:all"),
  nurture.DeleteTemplate
);

module.exports = router;
