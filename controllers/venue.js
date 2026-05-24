const VenueService = require("../services/VenueService");

const getVenues = async (req, res) => {
  try {
    const { status, limit = 100, skip = 0 } = req.query;
    const result = await VenueService.getAllVenues({
      status: status || "published",
      limit: parseInt(limit),
      skip: parseInt(skip),
    });
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

const getVenueBySlug = async (req, res) => {
  try {
    const { slug } = req.params;
    const venue = await VenueService.getVenueBySlug(slug);
    return res.status(200).json({ venue });
  } catch (err) {
    if (err.message === "Venue not found") {
      return res.status(404).json({ message: "Venue not found" });
    }
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { getVenues, getVenueBySlug };
