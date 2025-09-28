const express = require("express");
const router = express.Router();

const WedsyPackage = require("../controllers/wedsy-package");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.post("/", CheckAdminLogin, WedsyPackage.CreateNew);
router.get("/", WedsyPackage.GetAll);
router.get("/:_id", CheckAdminLogin, WedsyPackage.Get);
router.put("/:_id", CheckAdminLogin, WedsyPackage.Update);
router.delete("/:_id", CheckAdminLogin, WedsyPackage.Delete);

module.exports = router;
