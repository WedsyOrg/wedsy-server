const express = require("express");
const router = express.Router();

const notification = require("../controllers/notification");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.post("/", CheckAdminLogin, notification.CreateNew);
router.get("/", CheckLogin, notification.GetAll);
router.get("/unread-count", CheckLogin, notification.GetUnreadCount);
router.put("/:_id/read", CheckLogin, notification.MarkAsRead);
router.delete("/:_id", CheckLogin, notification.DeleteById);
router.delete("/", CheckLogin, notification.DeleteAll);

module.exports = router;
