const express = require("express");
const router = express.Router();

const vendorPersonalLead = require("../controllers/vendor-personal-lead");
const {
  CheckVendorLogin,
  CheckLogin,
  CheckAdminLogin,
} = require("../middlewares/auth");

router.post("/", CheckVendorLogin, vendorPersonalLead.CreateNew);
router.get("/", CheckLogin, vendorPersonalLead.GetAll);
router.get("/:_id", CheckLogin, vendorPersonalLead.Get);
router.put("/:_id", CheckVendorLogin, vendorPersonalLead.Update);
router.put(
  "/:_id/admin-notes",
  CheckAdminLogin,
  vendorPersonalLead.UpdateAdminNotes
);
router.delete("/:_id", CheckVendorLogin, vendorPersonalLead.Delete);

module.exports = router;
