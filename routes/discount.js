const express = require("express");
const router = express.Router();

const discount = require("../controllers/discount");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.post("/", CheckAdminLogin, discount.CreateNew);
router.get("/", CheckAdminLogin, discount.GetAll);
router.get("/:_id", CheckAdminLogin, discount.Get);
router.put("/:_id", CheckAdminLogin, discount.Update);
router.put("/:_id/status", CheckAdminLogin, discount.UpdateStatus);
router.delete("/:_id", CheckAdminLogin, discount.Delete);

module.exports = router;
