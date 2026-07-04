const express = require("express");
const router = express.Router();

const controller = require("../controllers/waConversation");
const { CheckAdminLogin } = require("../middlewares/auth");
const { requirePermission } = require("../middlewares/requirePermission");

// Conversations are lead surfaces: viewing follows leads:view scope, acting
// (takeover / handback / sending) follows leads:edit scope — both resolved
// through the linked enquiry's assignedTo, exactly like /enquiry routes.
router.get(
  "/conversations",
  CheckAdminLogin,
  requirePermission("leads:view:own", { ownerField: "assignedTo" }),
  controller.List
);
router.get(
  "/conversations/:id/messages",
  CheckAdminLogin,
  requirePermission("leads:view:own", { ownerField: "assignedTo" }),
  controller.Messages
);
router.post(
  "/conversations/:id/takeover",
  CheckAdminLogin,
  requirePermission("leads:edit:own", { ownerField: "assignedTo" }),
  controller.Takeover
);
router.post(
  "/conversations/:id/handback",
  CheckAdminLogin,
  requirePermission("leads:edit:own", { ownerField: "assignedTo" }),
  controller.Handback
);
router.post(
  "/conversations/:id/send",
  CheckAdminLogin,
  requirePermission("leads:edit:own", { ownerField: "assignedTo" }),
  controller.Send
);
router.post(
  "/conversations/:id/send-template",
  CheckAdminLogin,
  requirePermission("leads:edit:own", { ownerField: "assignedTo" }),
  controller.SendTemplate
);

module.exports = router;
