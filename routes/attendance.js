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

// Team visibility. RE-GATED 2026-08-21 from leads:view:own to attendance:view:own
// — attendance visibility was coupled to LEAD visibility, so an HR or payroll
// viewer with no lead permissions could not see the roster at all. Same scope
// machinery: ownerField "adminId" lets buildScopeFilter resolve own → self,
// team → subordinates, department → members, all → everyone.
//
// /me above stays login-only on purpose: a person must always be able to see
// their own late marks and fines without anyone granting it.
router.get(
  "/team",
  CheckAdminLogin,
  requirePermission("attendance:view:own", { ownerField: "adminId" }),
  controller.Team
);

module.exports = router;
