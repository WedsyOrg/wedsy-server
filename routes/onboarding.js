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

// Onboard flow (Slice 4). Start = Revenue Head (leads:onboard); state = client.
router.post(
  "/start",
  CheckAdminLogin,
  requirePermission("leads:onboard:own"),
  controller.StartOnboarding
);
router.get("/state", CheckLogin, controller.ClientState);

// Payments (Slice 5) — Razorpay link gen + offline-with-proof + online confirm.
// Gated to onboarders (Revenue Head / founder).
router.post(
  "/payment-link",
  CheckAdminLogin,
  requirePermission("leads:onboard:own"),
  controller.CreatePaymentLink
);
router.post(
  "/payment/offline",
  CheckAdminLogin,
  requirePermission("leads:onboard:own"),
  controller.RecordOfflinePayment
);
router.post(
  "/payment/:paymentId/confirm",
  CheckAdminLogin,
  requirePermission("leads:onboard:own"),
  controller.ConfirmOnlinePayment
);

module.exports = router;
