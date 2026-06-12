const Venue = require("../models/Venue");

// Escape regex metacharacters so user-supplied area text can't break (or
// abuse) the query — runs server-side on every public browse search.
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Amenity keys filterable on the public browse page (mirror Venue.amenities booleans).
const AMENITY_KEYS = new Set([
  "swimmingPool", "generatorBackup", "parking", "helipad", "garden", "airConditioning",
  "cctv", "wifi", "elevator", "bridalSuite", "kalyanMandap", "floatingMandap", "groomRoom",
  "makeupRoom", "changingRooms", "prayerRoom", "fireNOC", "liquorLicense", "dayOfCoordinator",
  "securityStaff", "housekeeping", "valetParking", "shuttleService", "petFriendly",
  "smokingAllowed", "evCharging",
]);
const SORTS = {
  newest: { createdAt: -1 },
  price_low: { "pricing.perPlate.veg": 1 },
  price_high: { "pricing.perPlate.veg": -1 },
  capacity: { "accommodation.totalCapacity": -1 },
  relevance: { dataCompleteness: -1, googleRating: -1 },
};

const findAll = async ({
  status, limit = 100, skip = 0, zone, area, search,
  venueType, amenities, veg, nonVeg, minCapacity, minPrice, maxPrice, sort,
} = {}) => {
  const query = {};
  if (status) query.status = status;
  if (zone) query.zone = zone;
  if (venueType) query.venueType = venueType;
  if (area) {
    const re = { $regex: escapeRegex(area), $options: "i" };
    query.$or = [{ locality: re }, { address: re }];
  }
  if (search) {
    query.name = { $regex: escapeRegex(search), $options: "i" };
  }
  // Amenity booleans — every requested amenity must be true. Accepts array or CSV.
  const amenityList = Array.isArray(amenities) ? amenities : typeof amenities === "string" ? amenities.split(",") : [];
  for (const a of amenityList) {
    const key = String(a).trim();
    if (AMENITY_KEYS.has(key)) query[`amenities.${key}`] = true;
  }
  // Dietary (cateringPolicy.dietaryOptions enum strings).
  if (veg === true || veg === "true") query["cateringPolicy.dietaryOptions"] = "Veg";
  if (nonVeg === true || nonVeg === "true") {
    query["cateringPolicy.dietaryOptions"] = query["cateringPolicy.dietaryOptions"]
      ? { $all: ["Veg", "Non-veg"] } : "Non-veg";
  }
  // Capacity — venue has at least one space seating >= minCapacity (uses spaces[]).
  if (minCapacity && Number(minCapacity) > 0) {
    query["spaces.capacitySeated"] = { $gte: Number(minCapacity) };
  }
  // Price range on per-plate veg (the single queryable price field; tiered pricing
  // is an array and is NOT range-filterable here — see report flag).
  const pp = {};
  if (minPrice && Number(minPrice) > 0) pp.$gte = Number(minPrice);
  if (maxPrice && Number(maxPrice) > 0) pp.$lte = Number(maxPrice);
  if (Object.keys(pp).length) query["pricing.perPlate.veg"] = pp;

  const sortSpec = SORTS[sort] || SORTS.relevance;
  const [venues, total] = await Promise.all([
    Venue.find(query)
      .select("name slug address city venueType capacity accommodation amenities catering cateringPolicy spaces pricing photos coverPhoto phone googlePlaceId googleRating googleReviewCount description seoKeywords dataCompleteness status zone locality googlePhotos featured createdAt")
      .sort(sortSpec)
      .skip(Number(skip) || 0)
      .limit(Math.min(Number(limit) || 100, 200))
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

const create = async (doc) => {
  const created = await Venue.create(doc);
  return created.toObject();
};

module.exports = { findAll, findBySlug, findById, updateBySlug, create };
