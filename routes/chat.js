const express = require("express");
const router = express.Router();

const chat = require("../controllers/chat");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

// router.post("/", CheckLogin, chat.CreateNew);
router.get("/", CheckLogin, chat.GetAll);
router.get("/:_id", CheckLogin, chat.Get);
router.post("/:_id/content/", CheckLogin, chat.CreateNewChatContent);
router.put("/:_id/content/:cId", CheckLogin, chat.UpdateChatContent);
router.put("/:_id/mark-read", CheckLogin, chat.MarkRead);
// router.put("/:_id", CheckLogin, chat.Update);
// router.delete("/:_id", CheckLogin, chat.Delete);

module.exports = router;
