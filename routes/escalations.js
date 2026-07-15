// W5 — /escalations — manager+ read (team gate; RH/founder widen to all
// in-service, ?scope honored downward only).
const express = require("express");
const router = express.Router();
const { CheckAdminLogin } = require("../middlewares/auth");
const { requirePermission } = require("../middlewares/requirePermission");
const escalations = require("../controllers/escalations");

router.get("/", CheckAdminLogin, requirePermission("leads:view:team", { ownerField: "assignedTo" }), escalations.List);

module.exports = router;
