const express = require("express");
const router = express.Router();

const enquiry = require("../controllers/enquiry");
const enquiryPipeline = require("../controllers/enquiry-pipeline");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

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

module.exports = router;
