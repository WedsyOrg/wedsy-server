// PLANNER P1 — workspace-level plan routes: the internal seam (the couple app
// later — shared secret or admin JWT) + the discount decide (eligibility
// enforced in-service via the disqualify helpers).
const express = require("express");
const router = express.Router();
const { CheckAdminLogin } = require("../middlewares/auth");
const { InternalOrAdmin } = require("../middlewares/internalAuth");
const plan = require("../controllers/plan");

router.get("/internal/:leadId/snapshots", InternalOrAdmin, plan.InternalSnapshots);
router.get("/internal/:leadId/snapshots/:snapshotId", InternalOrAdmin, plan.InternalSnapshot);
router.post("/internal/looks/react", InternalOrAdmin, plan.InternalReactLook);
router.post("/internal/moods/react", InternalOrAdmin, plan.InternalReactMood);
router.patch("/discounts/:id", CheckAdminLogin, plan.DecideDiscount);

module.exports = router;
