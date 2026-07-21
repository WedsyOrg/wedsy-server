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

// Addendum A1 — theme reads for planners (any authed admin).
router.get("/themes", CheckAdminLogin, plan.ThemesList);
router.get("/themes/:themeId/catalogue", CheckAdminLogin, plan.ThemeCatalogue);
// Addendum A3 — the couple's show-more signal (internal seam).
router.post("/internal/more-options", InternalOrAdmin, plan.InternalMoreOptions);
// Addendum A6 — the couple-facing published-draft read (frozen, never live).
router.get("/internal/:leadId/drafts/:eventId/published", InternalOrAdmin, plan.InternalPublishedDraft);

module.exports = router;
