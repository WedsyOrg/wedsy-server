const express = require("express");
const router = express.Router();

const taxation = require("../controllers/taxation");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.post("/", CheckAdminLogin, taxation.CreateNew);
router.get("/", CheckAdminLogin, taxation.GetAll);
router.get("/:_id", CheckAdminLogin, taxation.Get);
router.put("/:_id", CheckAdminLogin, taxation.Update);
router.put("/:_id/status", CheckAdminLogin, taxation.UpdateStatus);
router.delete("/:_id", CheckAdminLogin, taxation.Delete);

module.exports = router;
