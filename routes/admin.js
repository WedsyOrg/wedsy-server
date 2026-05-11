const express = require("express");
const router = express.Router();

const admin = require("../controllers/admin");
const { CheckAdminLogin } = require("../middlewares/auth");

router.get("/", CheckAdminLogin, admin.GetAll);

module.exports = router;
