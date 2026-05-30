const express = require("express");
const router = express.Router();

const department = require("../controllers/department");
const { CheckAdminLogin } = require("../middlewares/auth");

router.get("/", CheckAdminLogin, department.GetAll);

module.exports = router;
