const express = require("express");
const router = express.Router();

const org = require("../controllers/org");
const { CheckAdminLogin } = require("../middlewares/auth");
const { requirePermission } = require("../middlewares/requirePermission");

// MB10 Org & Access — read-only views over the live RBAC. Existing vocab only:
// the org chart is user-management info (users:view:all — founder *:*:all + CRM
// Admin users:*:all); the matrix is role info (roles:view:all — same holders).
router.get("/chart", CheckAdminLogin, requirePermission("users:view:all"), org.Chart);
router.get("/permission-matrix", CheckAdminLogin, requirePermission("roles:view:all"), org.PermissionMatrix);

module.exports = router;
