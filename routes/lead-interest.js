const express = require("express");
const router = express.Router();

const leadInterest = require("../controllers/lead-interest");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.post("/", CheckAdminLogin, leadInterest.CreateNew);
router.get("/", CheckAdminLogin, leadInterest.GetAll);
router.get("/:_id", CheckAdminLogin, leadInterest.Get);
router.put("/:_id", CheckAdminLogin, leadInterest.Update);
router.delete("/:_id", CheckAdminLogin, leadInterest.Delete);

module.exports = router;
