const express = require("express");
const router = express.Router();

const role = require("../controllers/role");
const { CheckAdminLogin } = require("../middlewares/auth");
const { requirePermission } = require("../middlewares/requirePermission");

router.get("/", CheckAdminLogin, requirePermission("roles:view:all"), role.GetAll);
router.put("/:id", CheckAdminLogin, requirePermission("roles:edit:all"), role.UpdatePermissions);
// Settings Suite: role lifecycle is part of the Roles settings category.
router.post("/", CheckAdminLogin, requirePermission("settings_roles:edit:all"), role.Create);
router.delete("/:id", CheckAdminLogin, requirePermission("settings_roles:edit:all"), role.Delete);

module.exports = router;
