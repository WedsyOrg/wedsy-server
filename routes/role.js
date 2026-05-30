const express = require("express");
const router = express.Router();

const role = require("../controllers/role");
const { CheckAdminLogin } = require("../middlewares/auth");

router.get("/", CheckAdminLogin, role.GetAll);

module.exports = router;
