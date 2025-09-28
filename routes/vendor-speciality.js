const express = require("express");
const router = express.Router();

const VendorSpeciality = require("../controllers/vendor-speciality");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.post("/", CheckAdminLogin, VendorSpeciality.CreateNew);
router.get("/", VendorSpeciality.GetAll);
router.get("/:_id", CheckAdminLogin, VendorSpeciality.Get);
router.put("/:_id", CheckAdminLogin, VendorSpeciality.Update);
router.delete("/:_id", CheckAdminLogin, VendorSpeciality.Delete);

module.exports = router;
