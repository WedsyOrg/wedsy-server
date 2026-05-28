const Venue = require("../models/Venue");

// Escape regex metacharacters so user-supplied area text can't break (or
// abuse) the query — runs server-side on every public browse search.
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const findAll = async ({ status, limit = 100, skip = 0, zone, area } = {}) => {
  const query = {};
  if (status) query.status = status;
  if (zone) query.zone = zone;
  // Area search matches BOTH the structured locality field (set by Google
  // enrichment) and the raw address — so typing "Yelahanka" finds venues
  // whether the locality is "Yelahanka" or the word lives in the address.
  if (area) {
    const re = { $regex: escapeRegex(area), $options: "i" };
    query.$or = [{ locality: re }, { address: re }];
  }
  const [venues, total] = await Promise.all([
    Venue.find(query)
      .select("name slug address city venueType capacity accommodation amenities catering pricing photos coverPhoto phone googlePlaceId googleRating googleReviewCount description seoKeywords dataCompleteness status zone locality googlePhotos featured")
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

const updateBySlug = async (slug, updates) => {
  return Venue.findOneAndUpdate({ slug }, { $set: updates }, { new: true }).lean();
};

module.exports = { findAll, findBySlug, findById, updateBySlug };
