const express = require("express");
const router = express.Router();

const role = require("../controllers/role");
const { CheckAdminLogin } = require("../middlewares/auth");
const { requirePermission } = require("../middlewares/requirePermission");

router.get("/", CheckAdminLogin, requirePermission("roles:view:all"), role.GetAll);

module.exports = router;
