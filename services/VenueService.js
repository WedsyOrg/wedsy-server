const VenueRepository = require("../repositories/VenueRepository");

const getAllVenues = async ({ status, limit, skip } = {}) => {
  return VenueRepository.findAll({ status, limit, skip });
};

const getVenueBySlug = async (slug) => {
  if (!slug) throw new Error("Slug is required");
  const venue = await VenueRepository.findBySlug(slug);
  if (!venue) throw new Error("Venue not found");
  return venue;
};

module.exports = { getAllVenues, getVenueBySlug };
