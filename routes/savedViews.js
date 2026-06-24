const express = require("express");
const router = express.Router();

const controller = require("../controllers/savedViews");
const { CheckAdminLogin } = require("../middlewares/auth");

// Per-user named filter sets — always own-only.
router.get("/", CheckAdminLogin, controller.List);
router.post("/", CheckAdminLogin, controller.Create);
router.put("/:id", CheckAdminLogin, controller.Update);
router.delete("/:id", CheckAdminLogin, controller.Delete);

module.exports = router;
