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

// Team-wide link roster — who can actually create a Meet link, and who cannot.
//
// GATED ON users:view:all, mirroring routes/org.js:11 (the org chart), and for
// the same reason: the RESPONSE is a list of every active admin with their name
// and email. That payload is user-management information whatever its purpose,
// so it answers to the permission that already governs enumerating staff. A
// settings permission would have let a settings-viewer list every colleague's
// email address, which is a wider grant than this needs.
//
// No new permission was invented — users:view:all already exists and is already
// used for exactly this shape of data.
router.get(
  "/link-roster",
  CheckAdminLogin,
  requirePermission("users:view:all"),
  controller.LinkRoster
);
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
