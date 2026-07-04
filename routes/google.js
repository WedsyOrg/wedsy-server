const express = require("express");
const router = express.Router();

const controller = require("../controllers/google");
const { CheckAdminLogin } = require("../middlewares/auth");
const { requirePermission } = require("../middlewares/requirePermission");

// OAuth — start needs a session; the callback is a bare browser redirect
// (identity travels in the signed state).
router.get("/oauth/start", CheckAdminLogin, controller.Start);
router.get("/oauth/callback", controller.Callback);

// Settings → My Account.
router.get("/status", CheckAdminLogin, controller.Status);
router.delete("/link", CheckAdminLogin, controller.Disconnect);

// Booking flow (cockpit finale / meet scheduler).
router.get(
  "/availability",
  CheckAdminLogin,
  requirePermission("leads:view:own", { ownerField: "assignedTo" }),
  controller.Availability
);
router.post(
  "/book",
  CheckAdminLogin,
  requirePermission("leads:edit:own", { ownerField: "assignedTo" }),
  controller.Book
);

module.exports = router;
