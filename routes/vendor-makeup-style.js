const express = require("express");
const router = express.Router();

const vendorMakeupStyle = require("../controllers/vendor-makeup-style");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.post("/", CheckAdminLogin, vendorMakeupStyle.CreateNew);
router.get("/", vendorMakeupStyle.GetAll);
router.get("/:_id", CheckAdminLogin, vendorMakeupStyle.Get);
router.put("/:_id", CheckAdminLogin, vendorMakeupStyle.Update);
router.post(
  "/:_id/preferred-look",
  CheckAdminLogin,
  vendorMakeupStyle.AddPreferredLook
);
router.delete(
  "/:_id/preferred-look",
  CheckAdminLogin,
  vendorMakeupStyle.RemovePreferredLook
);
router.delete("/:_id", CheckAdminLogin, vendorMakeupStyle.Delete);

module.exports = router;
