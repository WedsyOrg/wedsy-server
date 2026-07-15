// W1 — /me — caller-scoped reads/writes (workspace switcher). Auth only:
// everything here is inherently scoped to the caller, no broader permission.
const express = require("express");
const router = express.Router();
const { CheckAdminLogin } = require("../middlewares/auth");
const me = require("../controllers/me");

router.get("/workspaces", CheckAdminLogin, me.Workspaces);
router.put("/workspace", CheckAdminLogin, me.SetWorkspace);

module.exports = router;
