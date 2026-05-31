const express = require("express");
const router = express.Router();
const stage = require("../controllers/stage");
const { CheckAdminLogin } = require("../middlewares/auth");
// Read is available to any admin (Stage 1). Write/manage routes added in Stage 3 with RBAC.
router.get("/", CheckAdminLogin, stage.GetAll);
module.exports = router;
