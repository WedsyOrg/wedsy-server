const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueLeadInteraction = require("../models/VenueLeadInteraction");

const INTERACTION_TYPES = ["call", "whatsapp", "email", "site_visit", "meeting", "enquiry"];

// Resolve the venue from the slug and confirm the authenticated owner owns it and that
// the enquiry belongs to that venue. Returns { venue, enquiry } or sends the response.
async function resolveOwnedEnquiry(req, res) {
  const { slug, enquiryId } = req.params;
  const venue = await Venue.findOne({ slug }).select("_id").lean();
  if (!venue) {
    res.status(404).json({ message: "Venue not found" });
    return null;
  }
  if (String(venue._id) !== String(req.venueOwner.venueId)) {
    res.status(403).json({ message: "Forbidden" });
    return null;
  }
  const enquiry = await VenueEnquiry.findOne({ _id: enquiryId, venueId: venue._id })
    .select("_id")
    .lean();
  if (!enquiry) {
    res.status(404).json({ message: "Enquiry not found" });
    return null;
  }
  return { venue, enquiry };
}

// POST /venues/:slug/enquiries/:enquiryId/interactions
const addInteraction = async (req, res) => {
  try {
    const owned = await resolveOwnedEnquiry(req, res);
    if (!owned) return;

    const { type, note } = req.body || {};
    if (!type || !INTERACTION_TYPES.includes(type)) {
      return res.status(400).json({ message: "Invalid or missing interaction type" });
    }

    const interaction = await VenueLeadInteraction.create({
      enquiry: owned.enquiry._id,
      venue: owned.venue._id,
      type,
      note: typeof note === "string" ? note.trim() : "",
      createdBy: req.venueOwner.venueOwnerId,
    });

    return res.status(201).json({ interaction });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// GET /venues/:slug/enquiries/:enquiryId/interactions — timeline, newest first.
const getInteractions = async (req, res) => {
  try {
    const owned = await resolveOwnedEnquiry(req, res);
    if (!owned) return;

    const interactions = await VenueLeadInteraction.find({ enquiry: owned.enquiry._id })
      .sort({ createdAt: -1 })
      .populate("createdBy", "name")
      .lean();

    return res.status(200).json({ interactions, total: interactions.length });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { addInteraction, getInteractions };
