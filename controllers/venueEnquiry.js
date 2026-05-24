const VenueEnquiry = require("../models/VenueEnquiry");
const Venue = require("../models/Venue");

const createEnquiry = async (req, res) => {
  try {
    const { slug } = req.params;
    const { name, phone, eventDate, guestCount, budget, vibe, message } = req.body;

    if (!name || !phone) {
      return res.status(400).json({ message: "Name and phone are required" });
    }

    const venue = await Venue.findOne({ slug }).select("_id name phone status").lean();
    if (!venue) {
      return res.status(404).json({ message: "Venue not found" });
    }

    const enquiry = await VenueEnquiry.create({
      venueId: venue._id,
      name,
      phone,
      eventDate: eventDate || null,
      guestCount: guestCount || null,
      budget: budget || "",
      vibe: vibe || [],
      message: message || "",
      status: "new",
    });

    // TODO: Send WhatsApp to venue when Meta template is approved
    // await sendWhatsApp(venue.phone, "venue_new_enquiry", [venue.name, name, eventDate, guestCount]);

    return res.status(201).json({
      success: true,
      enquiryId: enquiry._id,
      message: "Enquiry sent successfully",
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { createEnquiry };
