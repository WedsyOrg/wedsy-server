const express = require("express");
const router = express.Router();

const config = require("../controllers/config");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.get("/", config.Get);
router.put("/", CheckAdminLogin, config.Update);

module.exports = router;
