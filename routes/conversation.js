const express = require("express");
const router = express.Router();
const {
  getVenueConversations,
  getCoupleConversations,
  sendMessage,
  getMessages,
  markAsRead,
} = require("../controllers/venueConversation");
const { CheckLogin } = require("../middlewares/auth");
const { venueOwnerAuth } = require("../middlewares/venueOwnerAuth");
const { coupleOrVenueAuth } = require("../middlewares/conversationAuth");

router.get("/venue/:slug", venueOwnerAuth, getVenueConversations);
router.get("/couple", CheckLogin, getCoupleConversations);
router.post("/:conversationId/messages", coupleOrVenueAuth, sendMessage);
router.get("/:conversationId/messages", coupleOrVenueAuth, getMessages);
router.patch("/:conversationId/read", coupleOrVenueAuth, markAsRead);

module.exports = router;
