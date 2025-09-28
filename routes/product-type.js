const express = require("express");
const router = express.Router();

const productType = require("../controllers/product-type");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.post("/", CheckAdminLogin, productType.CreateNew);
router.get("/", CheckAdminLogin, productType.GetAll);
router.get("/:_id", CheckAdminLogin, productType.Get);
router.put("/:_id", CheckAdminLogin, productType.Update);
router.delete("/:_id", CheckAdminLogin, productType.Delete);

module.exports = router;
