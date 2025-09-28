const express = require("express");
const router = express.Router();

const leadSource = require("../controllers/lead-source");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.post("/", CheckAdminLogin, leadSource.CreateNew);
router.get("/", CheckAdminLogin, leadSource.GetAll);
router.get("/:_id", CheckAdminLogin, leadSource.Get);
router.put("/:_id", CheckAdminLogin, leadSource.Update);
router.delete("/:_id", CheckAdminLogin, leadSource.Delete);

module.exports = router;
