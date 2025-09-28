const express = require("express");
const router = express.Router();

const enquiry = require("../controllers/enquiry");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.post("/", enquiry.CreateNew);
router.get("/", CheckAdminLogin, enquiry.GetAll);
router.put("/", CheckAdminLogin, enquiry.Update);
router.delete("/", CheckAdminLogin, enquiry.Delete);
router.get("/:_id", CheckAdminLogin, enquiry.Get);
router.post("/:_id/user", CheckAdminLogin, enquiry.CreateUser);
router.post("/:_id/conversations", CheckAdminLogin, enquiry.AddConversation);
router.put("/:_id/", CheckAdminLogin, enquiry.UpdateLead);
router.put("/:_id/notes", CheckAdminLogin, enquiry.UpdateNotes);
router.put("/:_id/call", CheckAdminLogin, enquiry.UpdateCallSchedule);

module.exports = router;
