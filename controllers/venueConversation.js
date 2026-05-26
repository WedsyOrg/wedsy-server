const VenueConversation = require("../models/VenueConversation");
const VenueMessage = require("../models/VenueMessage");
const Venue = require("../models/Venue");

const createOrGetConversation = async ({ venueId, enquiryId, userId }) => {
  if (!venueId || !enquiryId || !userId) {
    throw new Error("venueId, enquiryId and userId are required");
  }
  let conversation = await VenueConversation.findOne({ enquiryId });
  if (!conversation) {
    conversation = await VenueConversation.create({
      venueId,
      enquiryId,
      userId,
      status: "open",
      lastMessageAt: new Date(),
    });
  }
  return conversation;
};

const createOrGetConversationHandler = async (req, res) => {
  try {
    const { venueId, enquiryId, userId } = req.body || {};
    const conversation = await createOrGetConversation({ venueId, enquiryId, userId });
    return res.status(200).json({ conversation });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

const getVenueConversations = async (req, res) => {
  try {
    const { slug } = req.params;
    const venue = await Venue.findOne({ slug }).select("_id").lean();
    if (!venue) {
      return res.status(404).json({ message: "Venue not found" });
    }
    if (String(venue._id) !== String(req.venueOwner.venueId)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const conversations = await VenueConversation.find({ venueId: venue._id })
      .sort({ lastMessageAt: -1 })
      .populate("userId", "name phone")
      .populate("enquiryId", "eventDate guestCount vibe")
      .populate("venueId", "name slug")
      .lean();

    const conversationIds = conversations.map((c) => c._id);
    const lastMessages = await VenueMessage.aggregate([
      { $match: { conversationId: { $in: conversationIds } } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$conversationId",
          message: { $first: "$$ROOT" },
        },
      },
    ]);
    const lastMessageMap = {};
    lastMessages.forEach((entry) => {
      lastMessageMap[String(entry._id)] = entry.message;
    });

    const result = conversations.map((c) => ({
      ...c,
      lastMessage: lastMessageMap[String(c._id)] || null,
    }));

    return res.status(200).json({ conversations: result, total: result.length });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

const getCoupleConversations = async (req, res) => {
  try {
    const userId = req.auth && req.auth.user_id;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const conversations = await VenueConversation.find({ userId })
      .sort({ lastMessageAt: -1 })
      .populate("venueId", "name slug city images")
      .populate("enquiryId", "eventDate guestCount vibe")
      .lean();

    const conversationIds = conversations.map((c) => c._id);
    const lastMessages = await VenueMessage.aggregate([
      { $match: { conversationId: { $in: conversationIds } } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$conversationId",
          message: { $first: "$$ROOT" },
        },
      },
    ]);
    const lastMessageMap = {};
    lastMessages.forEach((entry) => {
      lastMessageMap[String(entry._id)] = entry.message;
    });

    const result = conversations.map((c) => ({
      ...c,
      type: "venue",
      lastMessage: lastMessageMap[String(c._id)] || null,
    }));

    return res.status(200).json({ conversations: result, total: result.length });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

const sendMessage = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { text, senderType, messageType } = req.body || {};

    if (!text || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ message: "Message text is required" });
    }
    if (!senderType || !["couple", "venue"].includes(senderType)) {
      return res.status(400).json({ message: "Invalid senderType" });
    }

    const conversation = await VenueConversation.findById(conversationId);
    if (!conversation) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    let senderId;
    if (senderType === "couple") {
      if (!req.auth || !req.auth.user_id) {
        return res.status(403).json({ message: "senderType does not match caller" });
      }
      if (String(req.auth.user_id) !== String(conversation.userId)) {
        return res.status(403).json({ message: "Forbidden" });
      }
      senderId = req.auth.user_id;
    } else {
      if (!req.venueOwner || !req.venueOwner.venueId) {
        return res.status(403).json({ message: "senderType does not match caller" });
      }
      if (String(req.venueOwner.venueId) !== String(conversation.venueId)) {
        return res.status(403).json({ message: "Forbidden" });
      }
      senderId = req.venueOwner.venueOwnerId;
    }

    const message = await VenueMessage.create({
      conversationId: conversation._id,
      senderId,
      senderType,
      messageType: messageType || "text",
      content: { text: text.trim() },
      isRead: false,
    });

    conversation.lastMessageAt = new Date();
    if (senderType === "couple") {
      conversation.unreadCountVenue = (conversation.unreadCountVenue || 0) + 1;
    } else {
      conversation.unreadCountCouple = (conversation.unreadCountCouple || 0) + 1;
    }
    await conversation.save();

    return res.status(201).json({ message });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

const getMessages = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const conversation = await VenueConversation.findById(conversationId);
    if (!conversation) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    let callerType;
    if (req.venueOwner && req.venueOwner.venueId) {
      if (String(req.venueOwner.venueId) !== String(conversation.venueId)) {
        return res.status(403).json({ message: "Forbidden" });
      }
      callerType = "venue";
    } else if (req.auth && req.auth.user_id) {
      if (String(req.auth.user_id) !== String(conversation.userId)) {
        return res.status(403).json({ message: "Forbidden" });
      }
      callerType = "couple";
    } else {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const messages = await VenueMessage.find({ conversationId: conversation._id })
      .sort({ createdAt: 1 })
      .lean();

    const otherPartyType = callerType === "couple" ? "venue" : "couple";
    await VenueMessage.updateMany(
      { conversationId: conversation._id, senderType: otherPartyType, isRead: false },
      { $set: { isRead: true } }
    );

    if (callerType === "couple") {
      conversation.unreadCountCouple = 0;
    } else {
      conversation.unreadCountVenue = 0;
    }
    await conversation.save();

    return res.status(200).json({ messages, total: messages.length });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

const markAsRead = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const conversation = await VenueConversation.findById(conversationId);
    if (!conversation) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    let callerType;
    if (req.venueOwner && req.venueOwner.venueId) {
      if (String(req.venueOwner.venueId) !== String(conversation.venueId)) {
        return res.status(403).json({ message: "Forbidden" });
      }
      callerType = "venue";
    } else if (req.auth && req.auth.user_id) {
      if (String(req.auth.user_id) !== String(conversation.userId)) {
        return res.status(403).json({ message: "Forbidden" });
      }
      callerType = "couple";
    } else {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const otherPartyType = callerType === "couple" ? "venue" : "couple";
    await VenueMessage.updateMany(
      { conversationId: conversation._id, senderType: otherPartyType, isRead: false },
      { $set: { isRead: true } }
    );

    if (callerType === "couple") {
      conversation.unreadCountCouple = 0;
    } else {
      conversation.unreadCountVenue = 0;
    }
    await conversation.save();

    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = {
  createOrGetConversation,
  createOrGetConversationHandler,
  getVenueConversations,
  getCoupleConversations,
  sendMessage,
  getMessages,
  markAsRead,
};
