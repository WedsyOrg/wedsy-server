const express = require("express");
const router = express.Router();

const controller = require("../controllers/onboarding");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");
const { requirePermission } = require("../middlewares/requirePermission");

// Milestone settings (Slice 2). GET readable by any admin (operational);
// PUT founder-gated via settings_onboarding:edit:all.
router.get("/milestones", CheckAdminLogin, controller.GetMilestones);
router.get("/milestones/preview", CheckAdminLogin, controller.PreviewMilestones);
router.put(
  "/milestones",
  CheckAdminLogin,
  requirePermission("settings_onboarding:edit:all"),
  controller.PutMilestones
);

// E-sign (Slice 3). Client-readable terms + accept (CheckLogin); status is OS.
router.get("/agreement", CheckLogin, controller.GetAgreementText);
router.post("/agreement", CheckLogin, controller.AcceptAgreement);
router.get("/", CheckAdminLogin, controller.GetStatus);

module.exports = router;
