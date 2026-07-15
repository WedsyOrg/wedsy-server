// W6 — /team — manager+ read (ICs 403 at the gate).
const express = require("express");
const router = express.Router();
const { CheckAdminLogin } = require("../middlewares/auth");
const { requirePermission } = require("../middlewares/requirePermission");
const team = require("../controllers/team");

router.get("/", CheckAdminLogin, requirePermission("leads:view:team", { ownerField: "assignedTo" }), team.Team);

module.exports = router;
