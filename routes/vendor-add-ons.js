const express = require("express");
const router = express.Router();

const vendorAddOns = require("../controllers/vendor-add-ons");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.post("/", CheckAdminLogin, vendorAddOns.CreateNew);
router.get("/", vendorAddOns.GetAll);
router.get("/:_id", CheckAdminLogin, vendorAddOns.Get);
router.put("/:_id", CheckAdminLogin, vendorAddOns.Update);
router.post("/:_id/makeup-style", CheckAdminLogin, vendorAddOns.AddMakeupStyle);
router.delete(
  "/:_id/makeup-style",
  CheckAdminLogin,
  vendorAddOns.RemoveMakeupStyle
);
router.delete("/:_id", CheckAdminLogin, vendorAddOns.Delete);

module.exports = router;
