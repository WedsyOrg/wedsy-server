const express = require("express");
const router = express.Router();

const project = require("../controllers/project");
const { CheckAdminLogin } = require("../middlewares/auth");
const { requirePermission } = require("../middlewares/requirePermission");

// Scope-filtered by CS owner: CS Exec sees own; Revenue Head / founders see
// department/all per their projects:view grant.
router.get(
  "/",
  CheckAdminLogin,
  requirePermission("projects:view:own", { ownerField: "csOwnerId" }),
  project.GetAll
);

module.exports = router;
