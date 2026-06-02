const express = require("express");
const router = express.Router();

const admin = require("../controllers/admin");
const venueJourney = require("../controllers/venue-journey");
const { CheckAdminLogin } = require("../middlewares/auth");

router.get("/", CheckAdminLogin, admin.GetAll);
router.get("/enquiries/:enquiryId/venue-journey", CheckAdminLogin, venueJourney.GetVenueJourney);
router.get("/venue-conversations/:conversationId/messages", CheckAdminLogin, venueJourney.GetVenueConversationMessages);

module.exports = router;
