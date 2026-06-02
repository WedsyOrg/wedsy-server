const express = require("express");
const router = express.Router();

const enquiry = require("../controllers/enquiry");
const enquiryPipeline = require("../controllers/enquiry-pipeline");
const disqualify = require("../controllers/disqualify");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");
const { requirePermission } = require("../middlewares/requirePermission");

router.post("/", enquiry.CreateNew);
router.get("/", CheckAdminLogin, enquiry.GetAll);
router.put("/", CheckAdminLogin, enquiry.Update);
router.delete("/", CheckAdminLogin, enquiry.Delete);
router.get("/:_id", CheckAdminLogin, enquiry.Get);
router.post("/:_id/user", CheckAdminLogin, enquiry.CreateUser);
router.post("/:_id/conversations", CheckAdminLogin, enquiry.AddConversation);
router.put(
  "/:_id/conversations/:conversationId",
  CheckAdminLogin,
  enquiry.UpdateConversation
);
router.delete(
  "/:_id/conversations/:conversationId",
  CheckAdminLogin,
  enquiry.DeleteConversation
);
router.put("/:_id/", CheckAdminLogin, enquiry.UpdateLead);
router.put("/:_id/notes", CheckAdminLogin, enquiry.UpdateNotes);
router.put("/:_id/call", CheckAdminLogin, enquiry.UpdateCallSchedule);
router.put("/:_id/stage", CheckAdminLogin, enquiryPipeline.UpdateStage);
router.put("/:_id/assign", CheckAdminLogin, enquiryPipeline.UpdateAssignedTo);
// Requesting a disqualification needs edit rights on the lead (Sales Executive has leads:edit:own).
router.post(
  "/:_id/disqualify",
  CheckAdminLogin,
  requirePermission("leads:edit:own"),
  disqualify.RequestDisqualify
);
// No requirePermission here — eligibility (manager OR leads:approve) is computed in the controller.
router.put(
  "/:_id/disqualify-decision",
  CheckAdminLogin,
  disqualify.DecideDisqualify
);

module.exports = router;
