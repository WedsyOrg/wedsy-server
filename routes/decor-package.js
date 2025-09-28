const express = require("express");
const router = express.Router();

const decorPackage = require("../controllers/decor-package");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.post("/", CheckAdminLogin, decorPackage.CreateNew);
router.get("/", decorPackage.GetAll);
router.get("/:_id", decorPackage.Get);
router.put("/:_id", CheckAdminLogin, decorPackage.Update);
router.delete("/:_id", CheckAdminLogin, decorPackage.Delete);

module.exports = router;
