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

// The employee's own note on one of their own days — including the fine on it.
// Login-only for the same reason /me is: explaining your own late mark is not a
// privilege someone grants you. Literal "me" segment, so it can never be read
// as an :adminId.
router.post("/me/:date/note", CheckAdminLogin, controller.Note);

// A MANAGER resolving a system-closed day for someone in their scope.
// attendance:edit (not payroll:approve) — resolving a day is a line-management
// act that happens on the day; converting one to LOP on a payroll sheet is a
// founder act that happens at month end. Same ownerField as /team, so own →
// self, team → subordinates, department → members, all → everyone.
router.post(
  "/:adminId/:date/resolve",
  CheckAdminLogin,
  requirePermission("attendance:edit:own", { ownerField: "adminId" }),
  controller.Resolve
);

module.exports = router;
