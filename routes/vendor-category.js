const express = require("express");
const router = express.Router();

const vendorCategory = require("../controllers/vendor-category");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.post("/", CheckAdminLogin, vendorCategory.CreateNew);
router.get("/", vendorCategory.GetAll);
router.get("/:_id", CheckAdminLogin, vendorCategory.Get);
router.put("/:_id", CheckAdminLogin, vendorCategory.Update);
router.delete("/:_id", CheckAdminLogin, vendorCategory.Delete);

module.exports = router;
