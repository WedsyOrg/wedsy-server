const express = require("express");
const router = express.Router();

const eventCommunity = require("../controllers/event-community");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.post("/", CheckAdminLogin, eventCommunity.CreateNew);
router.get("/", CheckAdminLogin, eventCommunity.GetAll);
router.get("/list", CheckLogin, eventCommunity.GetAll);
router.get("/:_id", CheckAdminLogin, eventCommunity.Get);
router.put("/:_id", CheckAdminLogin, eventCommunity.Update);
router.delete("/:_id", CheckAdminLogin, eventCommunity.Delete);

module.exports = router;
