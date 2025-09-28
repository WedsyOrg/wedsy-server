const express = require("express");
const router = express.Router();

const color = require("../controllers/color");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.post("/", CheckAdminLogin, color.CreateNew);
router.get("/", CheckAdminLogin, color.GetAll);
router.get("/:_id", CheckAdminLogin, color.Get);
router.put("/:_id", CheckAdminLogin, color.Update);
router.delete("/:_id", CheckAdminLogin, color.Delete);

module.exports = router;
