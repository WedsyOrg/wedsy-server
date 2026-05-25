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

const updateVenueBySlug = async (slug, ownerVenueId, updates = {}) => {
  if (!slug) throw new Error("Slug is required");
  const venue = await VenueRepository.findBySlug(slug);
  if (!venue) throw new Error("Venue not found");
  if (String(venue._id) !== String(ownerVenueId)) throw new Error("Forbidden");

  const payload = {};
  if (updates.name !== undefined) payload.name = updates.name;
  if (updates.description !== undefined) payload.description = updates.description;
  if (updates.phone !== undefined) payload.phone = updates.phone;
  if (updates.website !== undefined) payload.website = updates.website;
  if (updates.catering !== undefined) payload.catering = updates.catering;
  if (updates.venueType !== undefined) payload.venueType = updates.venueType;
  if (updates.capacity && typeof updates.capacity === "object") {
    if (updates.capacity.min !== undefined) payload["capacity.min"] = updates.capacity.min;
    if (updates.capacity.max !== undefined) payload["capacity.max"] = updates.capacity.max;
  }
  if (updates.accommodation && typeof updates.accommodation === "object") {
    if (updates.accommodation.available !== undefined) payload["accommodation.available"] = updates.accommodation.available;
    if (updates.accommodation.rooms !== undefined) payload["accommodation.rooms"] = updates.accommodation.rooms;
  }
  if (updates.pricing && typeof updates.pricing === "object" && updates.pricing.note !== undefined) {
    payload["pricing.note"] = updates.pricing.note;
  }

  return VenueRepository.updateBySlug(slug, payload);
};

module.exports = { getAllVenues, getVenueBySlug, updateVenueBySlug };
