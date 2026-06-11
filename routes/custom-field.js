const express = require("express");
const router = express.Router();

const customField = require("../controllers/custom-field");
const { CheckAdminLogin } = require("../middlewares/auth");
const { requirePermission } = require("../middlewares/requirePermission");

// Reads are open to any admin (cockpit + lead detail render the defs).
router.get("/", CheckAdminLogin, customField.GetAll);
// Writes are part of the Fields settings category.
router.post("/", CheckAdminLogin, requirePermission("settings_fields:edit:all"), customField.Create);
router.put("/:id", CheckAdminLogin, requirePermission("settings_fields:edit:all"), customField.Update);
router.delete("/:id", CheckAdminLogin, requirePermission("settings_fields:edit:all"), customField.Delete);

module.exports = router;
