const express = require("express");
const router = express.Router();
const stage = require("../controllers/stage");
const { CheckAdminLogin } = require("../middlewares/auth");
const { requirePermission } = require("../middlewares/requirePermission");

// Read is available to any authenticated admin.
router.get("/", CheckAdminLogin, stage.GetAll);

// Write/manage routes — RBAC-gated. "settings:edit:all" covers create/update/reorder;
// "settings:delete:all" covers delete. Founder *:*:all and CRM Admin satisfy both.
router.post(
  "/",
  CheckAdminLogin,
  requirePermission("settings:edit:all"),
  stage.Create
);
// "/reorder" must come BEFORE "/:id" so it isn't captured as an id param.
router.put(
  "/reorder",
  CheckAdminLogin,
  requirePermission("settings:edit:all"),
  stage.Reorder
);
router.put(
  "/:id",
  CheckAdminLogin,
  requirePermission("settings:edit:all"),
  stage.Update
);
router.delete(
  "/:id",
  CheckAdminLogin,
  requirePermission("settings:delete:all"),
  stage.Delete
);

module.exports = router;
