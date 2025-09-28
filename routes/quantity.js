const express = require("express");
const router = express.Router();

const quantity = require("../controllers/quantity");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.post("/", CheckAdminLogin, quantity.CreateNew);
router.get("/", CheckAdminLogin, quantity.GetAll);
router.get("/:_id", CheckAdminLogin, quantity.Get);
router.put("/:_id", CheckAdminLogin, quantity.Update);
router.delete("/:_id", CheckAdminLogin, quantity.Delete);

module.exports = router;
