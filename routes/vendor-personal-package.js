const express = require("express");
const router = express.Router();

const vendorPersonalPackage = require("../controllers/vendor-personal-package");
const {
  CheckVendorLogin,
  CheckLogin,
  CheckToken,
} = require("../middlewares/auth");

router.post("/", CheckLogin, vendorPersonalPackage.CreateNew);
router.get("/", CheckToken, vendorPersonalPackage.GetAll);
router.get("/:_id", CheckLogin, vendorPersonalPackage.Get);
router.put("/:_id", CheckLogin, vendorPersonalPackage.Update);
router.put("/:_id/status", CheckLogin, vendorPersonalPackage.UpdateStatus);
router.delete("/:_id", CheckLogin, vendorPersonalPackage.Delete);

module.exports = router;
