const express = require("express");
const router = express.Router();

const settings = require("../controllers/settings");
const { CheckAdminLogin } = require("../middlewares/auth");

// Category permission gates live INSIDE the controller — the gate depends on the
// requested category / key, which a route-level requirePermission cannot express.
router.get("/public", CheckAdminLogin, settings.GetPublic);
// Slice B5b — Agreement & Billing (whole-category read/write; founder-gated
// via settings_billing:edit:all inside the controller).
router.get("/billing", CheckAdminLogin, settings.GetBilling);
router.put("/billing", CheckAdminLogin, settings.PutBilling);
// Journey v2 (V5) — the engagement content library (settings_engagement gate
// inside the controller, same shape as billing).
router.get("/engagement", CheckAdminLogin, settings.GetEngagement);
router.put("/engagement", CheckAdminLogin, settings.PutEngagement);
// Planner P1 (P6) — the mood library (settings_moods gate).
router.get("/moods", CheckAdminLogin, settings.GetMoods);
// Auto-assign exclusions — the pool read (settings_assignment gate).
router.get("/auto-assign-pool", CheckAdminLogin, settings.GetAutoAssignPool);
// Addendum A1 — Planner themes (settings_planner gate).
router.get("/themes", CheckAdminLogin, settings.ListThemes);
router.post("/themes", CheckAdminLogin, settings.CreateTheme);
router.patch("/themes/:id", CheckAdminLogin, settings.PatchTheme);
router.delete("/themes/:id", CheckAdminLogin, settings.DeleteTheme);
router.put("/moods", CheckAdminLogin, settings.PutMoods);
router.get("/", CheckAdminLogin, settings.GetCategory);
router.put("/", CheckAdminLogin, settings.Put);

module.exports = router;
