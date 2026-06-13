const express = require("express");
const router = express.Router();

const controller = require("../controllers/attendance");
const { CheckAdminLogin } = require("../middlewares/auth");
const { requirePermission } = require("../middlewares/requirePermission");

// Everyone manages their own check-in/heartbeat and sees their own status.
router.post("/check-in", CheckAdminLogin, controller.CheckIn);
router.post("/check-out", CheckAdminLogin, controller.CheckOut);
router.post("/heartbeat", CheckAdminLogin, controller.Heartbeat);
router.get("/me", CheckAdminLogin, controller.Me);

// Team visibility follows the EXISTING lead-scope semantics (own/team/all),
// keyed on the attendance row's adminId: own → self, team → subordinates,
// all (Revenue Head / founder) → the whole daily list.
router.get(
  "/team",
  CheckAdminLogin,
  requirePermission("leads:view:own", { ownerField: "adminId" }),
  controller.Team
);

module.exports = router;
