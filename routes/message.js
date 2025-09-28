const express = require("express");
const router = express.Router();

const message = require("../controllers/message");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.post("/", CheckAdminLogin, message.CreateNew);
router.get("/", CheckAdminLogin, message.GetAll);
router.get("/:_id", CheckAdminLogin, message.Get);
router.put("/:_id", CheckAdminLogin, message.Update);
router.delete("/:_id", CheckAdminLogin, message.Delete);

module.exports = router;
