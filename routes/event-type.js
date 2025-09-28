const express = require("express");
const router = express.Router();

const eventType = require("../controllers/event-type");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.post("/", CheckAdminLogin, eventType.CreateNew);
router.get("/", CheckAdminLogin, eventType.GetAll);
router.get("/:_id", CheckAdminLogin, eventType.Get);
router.put("/:_id", CheckAdminLogin, eventType.Update);
router.delete("/:_id", CheckAdminLogin, eventType.Delete);

module.exports = router;
