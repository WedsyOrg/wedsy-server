// W2 — /my-work — inherently caller-scoped reads; the permission gate mirrors
// the respond-now route (any leads-viewing role passes, triage is re-checked
// in-service for the triage leg).
const express = require("express");
const router = express.Router();
const { CheckAdminLogin } = require("../middlewares/auth");
const { requirePermission } = require("../middlewares/requirePermission");
const myWork = require("../controllers/myWork");

router.get("/now", CheckAdminLogin, requirePermission("leads:view:own", { ownerField: "assignedTo" }), myWork.Now);
router.get("/schedule", CheckAdminLogin, requirePermission("leads:view:own", { ownerField: "assignedTo" }), myWork.Schedule);

module.exports = router;
