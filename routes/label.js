const express = require("express");
const router = express.Router();

const label = require("../controllers/label");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.post("/", CheckAdminLogin, label.CreateNew);
router.get("/", CheckAdminLogin, label.GetAll);
router.get("/:_id", CheckAdminLogin, label.Get);
router.put("/:_id", CheckAdminLogin, label.Update);
router.delete("/:_id", CheckAdminLogin, label.Delete);

module.exports = router;
