const express = require("express");
const router = express.Router();

const stepDefinition = require("../controllers/stepDefinition");
const { CheckAdminLogin } = require("../middlewares/auth");
const { requirePermission } = require("../middlewares/requirePermission");

// MB8b Slice 1 — configurable journey step definitions (Settings). Reads are
// open to any admin (the lead page + per-lead instantiation render the defs).
// Writes are gated settings:edit:all — satisfied by Founder (*:*:all) and
// CRM-Admin (settings:*:all). No new RBAC vocabulary.
router.get("/", CheckAdminLogin, stepDefinition.GetAll);
router.post("/", CheckAdminLogin, requirePermission("settings:edit:all"), stepDefinition.Create);
router.put("/reorder", CheckAdminLogin, requirePermission("settings:edit:all"), stepDefinition.Reorder);
router.post("/seed", CheckAdminLogin, requirePermission("settings:edit:all"), stepDefinition.Seed);
router.put("/:id", CheckAdminLogin, requirePermission("settings:edit:all"), stepDefinition.Update);
router.delete("/:id", CheckAdminLogin, requirePermission("settings:edit:all"), stepDefinition.Delete);

module.exports = router;
