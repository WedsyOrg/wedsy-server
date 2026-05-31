const VenueJourneyService = require("../services/VenueJourneyService");

// GET /admin/enquiries/:enquiryId/venue-journey
const GetVenueJourney = async (req, res) => {
  try {
    const result = await VenueJourneyService.getJourneyForEnquiry(req.params.enquiryId);
    res.status(200).json(result);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
};

// GET /admin/venue-conversations/:conversationId/messages
const GetVenueConversationMessages = async (req, res) => {
  try {
    const result = await VenueJourneyService.getConversationMessages(req.params.conversationId);
    res.status(200).json(result);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
};

module.exports = {
  GetVenueJourney,
  GetVenueConversationMessages,
};
