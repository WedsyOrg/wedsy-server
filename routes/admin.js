const express = require("express");
const router = express.Router();

const admin = require("../controllers/admin");
const venueJourney = require("../controllers/venue-journey");
const { CheckAdminLogin } = require("../middlewares/auth");
const { requirePermission } = require("../middlewares/requirePermission");

// MANAGE — lists all admins (acts on OTHER admins). RBAC-gated.
// Founder *:*:all and CRM Admin users:*:all satisfy this; others 403.
router.get("/", CheckAdminLogin, admin.GetAll);
// MANAGE — create/update other admins. Founder-gated via users:*:all permissions.
router.post("/", CheckAdminLogin, requirePermission("users:create:all"), admin.CreateAdmin);
// The two venue-journey reads below are enquiry/venue operational data (not admin/user
// management) and are intentionally left auth-only — see classification notes.
router.get("/enquiries/:enquiryId/venue-journey", CheckAdminLogin, venueJourney.GetVenueJourney);
router.get("/venue-conversations/:conversationId/messages", CheckAdminLogin, venueJourney.GetVenueConversationMessages);
// ACCESS CONTROL (password-mgmt) — gated to the new team:manage_access permission
// (founder *:*:all + the Admin role; NOT regular members). Literal paths, kept
// above the PUT /:id param route.
router.post("/set-password", CheckAdminLogin, requirePermission("team:manage_access:all"), admin.SetMemberPassword);
router.post("/access", CheckAdminLogin, requirePermission("team:manage_access:all"), admin.SetMemberAccess);
// Slice A3 — offboard a DISABLED admin's working set (open leads + lane
// ownerships + open tasks) in one action. Same gate as disable itself.
router.post("/:_id/offboard-leads", CheckAdminLogin, requirePermission("team:manage_access:all"), admin.OffboardLeads);
// PUT /:id is method-distinct from the GETs above, but kept last so any future
// param routes stay below the literal paths.
router.put("/:id", CheckAdminLogin, requirePermission("users:edit:all"), admin.UpdateAdmin);

module.exports = router;
