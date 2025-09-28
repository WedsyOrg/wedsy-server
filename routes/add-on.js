const express = require("express");
const router = express.Router();

const addOn = require("../controllers/add-on");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.post("/", CheckAdminLogin, addOn.CreateNew);
router.get("/", CheckAdminLogin, addOn.GetAll);
router.get("/:_id", CheckAdminLogin, addOn.Get);
router.put("/:_id", CheckAdminLogin, addOn.Update);
router.delete("/:_id", CheckAdminLogin, addOn.Delete);

module.exports = router;
