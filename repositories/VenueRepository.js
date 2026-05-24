const Venue = require("../models/Venue");

const findAll = async ({ status, limit = 100, skip = 0 } = {}) => {
  const query = {};
  if (status) query.status = status;
  const [venues, total] = await Promise.all([
    Venue.find(query)
      .select("name slug address city venueType capacity accommodation amenities catering pricing photos coverPhoto phone googlePlaceId googleRating googleReviewCount description seoKeywords dataCompleteness status")
      .sort({ dataCompleteness: -1, googleRating: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Venue.countDocuments(query),
  ]);
  return { venues, total };
};

const findBySlug = async (slug) => {
  return Venue.findOne({ slug }).lean();
};

const findById = async (id) => {
  return Venue.findById(id).lean();
};

module.exports = { findAll, findBySlug, findById };
