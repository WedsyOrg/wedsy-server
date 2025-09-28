const express = require("express");
const router = express.Router();

const vendorPreferredLook = require("../controllers/vendor-preferred-look");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.post("/", CheckAdminLogin, vendorPreferredLook.CreateNew);
router.get("/", vendorPreferredLook.GetAll);
router.get("/:_id", CheckAdminLogin, vendorPreferredLook.Get);
router.put("/:_id", CheckAdminLogin, vendorPreferredLook.Update);
router.delete("/:_id", CheckAdminLogin, vendorPreferredLook.Delete);

module.exports = router;
