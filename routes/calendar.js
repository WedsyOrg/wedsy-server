const express = require("express");
const router = express.Router();

const controller = require("../controllers/calendar");
const { CheckAdminLogin } = require("../middlewares/auth");
const { requirePermission } = require("../middlewares/requirePermission");

// Team calendar grid — visibility rides the lead-scope semantics keyed on the
// event owner (own → my row, team → my people, all → everyone).
router.get(
  "/team",
  CheckAdminLogin,
  requirePermission("leads:view:own", { ownerField: "ownerId" }),
  controller.Team
);

// Own calendar operations.
router.post("/events", CheckAdminLogin, controller.Create);
router.put("/events/:id/notes", CheckAdminLogin, controller.SaveNotes);
router.post("/events/:id/close", CheckAdminLogin, controller.Close);
router.get("/meeting-mode", CheckAdminLogin, controller.MeetingMode);

// Unclosed-meetings oversight (Revenue Head / managers — team+ scope).
router.get(
  "/unclosed",
  CheckAdminLogin,
  requirePermission("leads:view:team", { ownerField: "ownerId" }),
  controller.Unclosed
);

// Huddles.
router.post("/huddles/:id/complete", CheckAdminLogin, controller.CompleteHuddle);

// Calendar items for one lead (Client File chip).
router.get(
  "/lead/:leadId",
  CheckAdminLogin,
  requirePermission("leads:view:own", { ownerField: "assignedTo" }),
  controller.LeadEvents
);

module.exports = router;
