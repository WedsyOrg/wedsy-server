const mongoose = require("mongoose");
const VenueJourneyRepository = require("../repositories/VenueJourneyRepository");

const err = (status, message) => Object.assign(new Error(message), { status });

// Aggregate the full venue journey for a CRM lead: lead -> user (by phone) -> venue enquiries + conversations.
const getJourneyForEnquiry = async (enquiryId) => {
  if (!mongoose.Types.ObjectId.isValid(enquiryId)) {
    throw err(400, "Invalid enquiry id.");
  }
  const lead = await VenueJourneyRepository.findEnquiryById(enquiryId);
  if (!lead) {
    throw err(404, "Lead not found.");
  }

  const phone = lead.phone || null;
  const user = await VenueJourneyRepository.findUserByPhone(phone);
  const userId = user ? user._id : null;

  const [enquiries, conversations] = await Promise.all([
    VenueJourneyRepository.findVenueEnquiries({ userId, phone }),
    VenueJourneyRepository.findVenueConversations({ userId }),
  ]);

  return {
    lead: { _id: lead._id, name: lead.name, phone: lead.phone },
    user: user ? { _id: user._id, name: user.name, phone: user.phone } : null,
    enquiries,
    conversations,
  };
};

const getConversationMessages = async (conversationId) => {
  if (!mongoose.Types.ObjectId.isValid(conversationId)) {
    throw err(400, "Invalid conversation id.");
  }
  const convo = await VenueJourneyRepository.findConversationById(conversationId);
  if (!convo) {
    throw err(404, "Conversation not found.");
  }
  const messages = await VenueJourneyRepository.findMessagesByConversationId(conversationId);
  return { conversationId, messages };
};

module.exports = {
  getJourneyForEnquiry,
  getConversationMessages,
};
