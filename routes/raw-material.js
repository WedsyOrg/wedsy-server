const express = require("express");
const router = express.Router();

const rawMaterial = require("../controllers/raw-material");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.post("/", CheckAdminLogin, rawMaterial.CreateNew);
router.get("/", CheckAdminLogin, rawMaterial.GetAll);
router.get("/:_id", CheckAdminLogin, rawMaterial.Get);
router.put("/:_id", CheckAdminLogin, rawMaterial.Update);
router.delete("/:_id", CheckAdminLogin, rawMaterial.Delete);

module.exports = router;
