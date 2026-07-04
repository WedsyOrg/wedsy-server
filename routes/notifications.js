const express = require("express");
const router = express.Router();

const controller = require("../controllers/calendar");
const { CheckAdminLogin } = require("../middlewares/auth");

// In-OS dashboard notification entries — always own-only.
router.get("/", CheckAdminLogin, controller.MyNotifications);
router.put("/read-all", CheckAdminLogin, controller.MarkAllRead);
router.put("/:id/read", CheckAdminLogin, controller.MarkRead);

module.exports = router;
