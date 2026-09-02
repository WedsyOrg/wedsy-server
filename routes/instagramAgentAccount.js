// Admin-facing Instagram agent surface (mounted at /instagram-agent).
// Separate file from instagramAgent.js deliberately: that router is the
// unauthenticated Meta WEBHOOK (mounted under /webhook, signature-verified);
// this one is the CRM's own authed read side. Mixing them would put
// CheckAdminLogin in front of Meta's webhook or webhook paths under /instagram-agent.
//
// The ONE exception to "authed" here is /callback, and it is not a slip: Meta
// redirects the admin's BROWSER to it cross-site, so no session cookie is
// present and CheckAdminLogin would reject every real authorisation. Its guard
// is the single-use OAuth `state` instead — see controllers/instagramOauth.js.
const express = require("express");
const router = express.Router();
const { CheckAdminLogin } = require("../middlewares/auth");
const { ConnectedAccount } = require("../controllers/instagramAgent");
const { Connect, Callback, Disconnect } = require("../controllers/instagramOauth");

router.get("/connected-account", CheckAdminLogin, ConnectedAccount);

// OAuth connect flow (Instagram Login, Tech Provider model).
//
// INTENDED GUARD, when the owner portal needs these routes:
// middlewares/adminOrVenueOwnerAuth.js. It admits an admin token AND a
// venue_owner token, so one route serves both the OS inbox and the owner portal
// without forking into a parallel /venue-instagram-agent. It stays
// CheckAdminLogin for now — only the OS inbox calls this today — and
// resolveActor() in controllers/instagramOauth.js already reads both request
// shapes, so the swap is this line and nothing else. Please do not invent a
// third guard.
router.get("/connect", CheckAdminLogin, Connect);
router.get("/callback", Callback); // NO AUTH BY DESIGN — see the note above.
router.post("/disconnect", CheckAdminLogin, Disconnect);

module.exports = router;
