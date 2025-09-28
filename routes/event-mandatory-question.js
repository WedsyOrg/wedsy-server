const express = require("express");
const router = express.Router();

const eventMandatoryQuestion = require("../controllers/event-mandatory-question");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.post("/", CheckAdminLogin, eventMandatoryQuestion.CreateNew);
router.get("/", CheckAdminLogin, eventMandatoryQuestion.GetAll);
router.get("/:_id", CheckAdminLogin, eventMandatoryQuestion.Get);
router.put("/:_id", CheckAdminLogin, eventMandatoryQuestion.Update);
router.delete("/:_id", CheckAdminLogin, eventMandatoryQuestion.Delete);

module.exports = router;
