const Enquiry = require("../models/Enquiry");
const User = require("../models/User");
const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueConversation = require("../models/VenueConversation");
const VenueMessage = require("../models/VenueMessage");

const findEnquiryById = async (_id) => {
  return await Enquiry.findById(_id).lean();
};

// Resolve the lead's User by phone (leads carry phone, not a user ref).
const findUserByPhone = async (phone) => {
  if (!phone) return null;
  return await User.findOne({ phone }).select({ name: 1, phone: 1, email: 1 }).lean();
};

// Venue enquiries that belong to this couple: by userId OR by phone match
// (VenueEnquiry stores phone in either `phone` or `couplePhone`, both legacy/preferred).
const findVenueEnquiries = async ({ userId, phone }) => {
  const or = [];
  if (userId) or.push({ userId });
  if (phone) or.push({ phone }, { couplePhone: phone });
  if (or.length === 0) return [];
  return await VenueEnquiry.find({ $or: or })
    .populate("venueId", "name slug coverPhoto venueType city")
    .sort({ createdAt: -1 })
    .lean();
};

// Conversations require a userId (schema-required), so only resolvable when the lead has a User.
const findVenueConversations = async ({ userId }) => {
  if (!userId) return [];
  return await VenueConversation.find({ userId })
    .populate("venueId", "name slug coverPhoto venueType city")
    .populate("enquiryId", "eventDate guestCount stage")
    .sort({ lastMessageAt: -1 })
    .lean();
};

const findMessagesByConversationId = async (conversationId) => {
  return await VenueMessage.find({ conversationId })
    .sort({ createdAt: 1 })
    .lean();
};

const findConversationById = async (_id) => {
  return await VenueConversation.findById(_id).lean();
};

module.exports = {
  findEnquiryById,
  findUserByPhone,
  findVenueEnquiries,
  findVenueConversations,
  findMessagesByConversationId,
  findConversationById,
};
