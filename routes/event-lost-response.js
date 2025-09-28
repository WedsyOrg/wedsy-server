const express = require("express");
const router = express.Router();

const eventLostResponse = require("../controllers/event-lost-response");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.post("/", CheckAdminLogin, eventLostResponse.CreateNew);
router.get("/", CheckAdminLogin, eventLostResponse.GetAll);
router.get("/:_id", CheckAdminLogin, eventLostResponse.Get);
router.put("/:_id", CheckAdminLogin, eventLostResponse.Update);
router.delete("/:_id", CheckAdminLogin, eventLostResponse.Delete);

module.exports = router;
