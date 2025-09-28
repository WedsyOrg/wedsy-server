const express = require("express");
const router = express.Router();

const vendor = require("../controllers/vendor");
const {
  CheckLogin,
  CheckAdminLogin,
  CheckVendorLogin,
  CheckToken,
} = require("../middlewares/auth");

router.post("/", vendor.CreateNew);
router.get("/", CheckToken, vendor.GetAll);
router.get("/:_id", CheckToken, vendor.Get);
router.get("/:_id/last-active", CheckAdminLogin, vendor.GetVendorLastActive);
router.post("/:_id/notes", CheckAdminLogin, vendor.AddNotes);
router.put("/", CheckVendorLogin, vendor.Update);
router.put("/:_id", CheckAdminLogin, vendor.Update);
router.delete("/:_id", CheckAdminLogin, vendor.Delete);
router.delete("/", CheckAdminLogin, vendor.DeleteVendors);

module.exports = router;
