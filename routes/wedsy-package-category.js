const express = require("express");
const router = express.Router();

const WedsyPackageCategory = require("../controllers/wedsy-package-category");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.post("/", CheckAdminLogin, WedsyPackageCategory.CreateNew);
router.get("/", CheckAdminLogin, WedsyPackageCategory.GetAll);
router.get("/:_id", CheckAdminLogin, WedsyPackageCategory.Get);
router.put("/:_id", CheckAdminLogin, WedsyPackageCategory.Update);
router.delete("/:_id", CheckAdminLogin, WedsyPackageCategory.Delete);

module.exports = router;
