const express = require("express");
const router = express.Router();

const unit = require("../controllers/unit");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.post("/", CheckAdminLogin, unit.CreateNew);
router.get("/", CheckAdminLogin, unit.GetAll);
router.get("/:_id", CheckAdminLogin, unit.Get);
router.put("/:_id", CheckAdminLogin, unit.Update);
router.delete("/:_id", CheckAdminLogin, unit.Delete);

module.exports = router;
