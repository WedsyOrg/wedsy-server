const express = require("express");
const router = express.Router();

const leadLostResponse = require("../controllers/lead-lost-response");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.post("/", CheckAdminLogin, leadLostResponse.CreateNew);
router.get("/", CheckAdminLogin, leadLostResponse.GetAll);
router.get("/:_id", CheckAdminLogin, leadLostResponse.Get);
router.put("/:_id", CheckAdminLogin, leadLostResponse.Update);
router.delete("/:_id", CheckAdminLogin, leadLostResponse.Delete);

module.exports = router;
