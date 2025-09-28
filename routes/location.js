const express = require("express");
const router = express.Router();

const location = require("../controllers/location");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.post("/", CheckAdminLogin, location.CreateNew);
router.get("/", location.GetAll);
router.get("/:_id", CheckAdminLogin, location.Get);
router.put("/:_id", CheckAdminLogin, location.Update);
router.delete("/:_id", CheckAdminLogin, location.Delete);

module.exports = router;
