const express = require("express");
const router = express.Router();

const coupon = require("../controllers/coupon");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.post("/", CheckAdminLogin, coupon.CreateNew);
router.get("/", CheckAdminLogin, coupon.GetAll);
router.get("/:_id", CheckAdminLogin, coupon.Get);
router.put("/:_id", CheckAdminLogin, coupon.Update);
router.put("/:_id/status", CheckAdminLogin, coupon.UpdateStatus);
router.delete("/:_id", CheckAdminLogin, coupon.Delete);

module.exports = router;
