const VenueRepository = require("../repositories/VenueRepository");

const getAllVenues = async ({ status, limit, skip, zone, area, search } = {}) => {
  return VenueRepository.findAll({ status, limit, skip, zone, area, search });
};

const getVenueBySlug = async (slug) => {
  if (!slug) throw new Error("Slug is required");
  const venue = await VenueRepository.findBySlug(slug);
  if (!venue) throw new Error("Venue not found");
  return venue;
};

// Mirror of models/Venue.js venueType enum (do not add/alter schema fields).
const VENUE_TYPE_ENUM = [
  "resort", "farmhouse", "villa", "hotel", "heritage", "banquet_hall", "club", "other",
];

const badRequest = (message) => {
  const err = new Error(message);
  err.status = 400;
  return err;
};

// URL-safe slug from a name: lowercase, non-alphanumerics → single hyphen, trimmed.
const slugify = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// Create a new venue. Always status "draft"; slug auto-generated + made unique
// (append -2, -3, … on collision). Throws a 400-style error on validation failure.
const createVenue = async (input = {}) => {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw badRequest("name is required");
  const { venueType } = input;
  if (!venueType || !VENUE_TYPE_ENUM.includes(venueType)) {
    throw badRequest("venueType is required and must be one of: " + VENUE_TYPE_ENUM.join(", "));
  }

  const baseSlug = slugify(name) || "venue";
  const doc = {
    ...input,
    name,
    venueType,
    city: typeof input.city === "string" && input.city.trim() ? input.city.trim() : "Bangalore",
    status: "draft", // new venues are never auto-published
  };
  delete doc.slug; // slug is service-controlled, never taken from input

  for (let attempt = 1; attempt <= 50; attempt++) {
    const slug = attempt === 1 ? baseSlug : `${baseSlug}-${attempt}`;
    try {
      return await VenueRepository.create({ ...doc, slug });
    } catch (err) {
      // Duplicate slug (unique index) → try the next suffix; rethrow anything else.
      if (err && err.code === 11000 && attempt < 50) continue;
      throw err;
    }
  }
  throw new Error("Could not generate a unique slug for venue");
};

const SCALAR_TOP_LEVEL = [
  "name", "tagline", "description", "venueType", "established",
  "city", "address", "phone", "email", "website",
  "coverPhoto", "featurePhoto",
  // Places-enrich location fields (additive)
  "state", "pincode", "googlePlaceId", "formattedAddress",
  // Phase 3 invoicing profile (additive)
  "gstin", "pan", "invoicePrefix",
];

const ARRAY_TOP_LEVEL = ["areas", "blockedDates", "spaces"];

const ACCOMMODATION_SCALARS = ["available", "totalCapacity"];

const PRICING_SCALARS = [
  "minimumDuration", "securityDeposit", "advancePercent", "peakSeasonMarkup", "note",
];

const CATERING_SCALARS = [
  "type", "outsideKitchenFee", "outsideSetupFrom", "minPerPlate",
];

const CATERING_ARRAYS = ["dietaryOptions", "cuisines"];

const DECOR_FIELDS = ["outsideAllowed", "inHouseAvailable", "setupAccessFrom", "restrictions"];

const MUSIC_FIELDS = [
  "liveMusicAllowed", "djAllowed", "outdoorCurfew", "indoorCurfew", "inHouseSoundSystem",
];

const AMENITY_BOOLEANS = [
  "swimmingPool", "generatorBackup", "parking", "helipad", "garden",
  "airConditioning", "cctv", "wifi", "elevator", "bridalSuite",
  "kalyanMandap", "floatingMandap",
  "groomRoom", "makeupRoom", "changingRooms", "prayerRoom", "fireNOC",
  "liquorLicense", "dayOfCoordinator", "securityStaff", "housekeeping",
  "valetParking", "shuttleService", "petFriendly", "smokingAllowed",
  "evCharging",
];

const PHOTO_BUCKETS = ["venue", "decor", "rooms", "spaces"];

const POLICY_FIELDS = ["cancellation", "refund", "otherRestrictions"];

const CONTACT_SCALARS = [
  "primaryName", "primaryPhone", "secondaryPhone", "email", "website", "bestTimeToReach",
  "whatsappPhone", "whatsappSameAsPrimary",
];

const updateVenueBySlug = async (slug, ownerVenueId, updates = {}) => {
  if (!slug) throw new Error("Slug is required");
  const venue = await VenueRepository.findBySlug(slug);
  if (!venue) throw new Error("Venue not found");
  if (String(venue._id) !== String(ownerVenueId)) throw new Error("Forbidden");

  const $set = {};

  for (const k of SCALAR_TOP_LEVEL) {
    if (updates[k] !== undefined) $set[k] = updates[k];
  }
  for (const k of ARRAY_TOP_LEVEL) {
    if (Array.isArray(updates[k])) $set[k] = updates[k];
  }

  // Places-enrich: persist the GeoJSON location object when provided.
  if (updates.location && typeof updates.location === "object") {
    $set.location = updates.location;
  }

  if (updates.accommodation && typeof updates.accommodation === "object") {
    for (const k of ACCOMMODATION_SCALARS) {
      if (updates.accommodation[k] !== undefined) $set[`accommodation.${k}`] = updates.accommodation[k];
    }
    if (Array.isArray(updates.accommodation.roomTypes)) {
      $set["accommodation.roomTypes"] = updates.accommodation.roomTypes;
    }
  }

  if (updates.pricing && typeof updates.pricing === "object") {
    for (const k of PRICING_SCALARS) {
      if (updates.pricing[k] !== undefined) $set[`pricing.${k}`] = updates.pricing[k];
    }
    if (Array.isArray(updates.pricing.tiers)) $set["pricing.tiers"] = updates.pricing.tiers;
    if (updates.pricing.perPlate && typeof updates.pricing.perPlate === "object") {
      if (updates.pricing.perPlate.veg !== undefined) $set["pricing.perPlate.veg"] = updates.pricing.perPlate.veg;
      if (updates.pricing.perPlate.nonVeg !== undefined) $set["pricing.perPlate.nonVeg"] = updates.pricing.perPlate.nonVeg;
    }
  }

  if (updates.cateringPolicy && typeof updates.cateringPolicy === "object") {
    for (const k of CATERING_SCALARS) {
      if (updates.cateringPolicy[k] !== undefined) $set[`cateringPolicy.${k}`] = updates.cateringPolicy[k];
    }
    for (const k of CATERING_ARRAYS) {
      if (Array.isArray(updates.cateringPolicy[k])) $set[`cateringPolicy.${k}`] = updates.cateringPolicy[k];
    }
  }

  if (updates.decorPolicy && typeof updates.decorPolicy === "object") {
    for (const k of DECOR_FIELDS) {
      if (updates.decorPolicy[k] !== undefined) $set[`decorPolicy.${k}`] = updates.decorPolicy[k];
    }
  }

  if (updates.musicPolicy && typeof updates.musicPolicy === "object") {
    for (const k of MUSIC_FIELDS) {
      if (updates.musicPolicy[k] !== undefined) $set[`musicPolicy.${k}`] = updates.musicPolicy[k];
    }
  }

  if (updates.amenities && typeof updates.amenities === "object") {
    for (const k of AMENITY_BOOLEANS) {
      if (updates.amenities[k] !== undefined) $set[`amenities.${k}`] = updates.amenities[k];
    }
    if (updates.amenities.parkingCapacity !== undefined) {
      $set["amenities.parkingCapacity"] = updates.amenities.parkingCapacity;
    }
    if (updates.amenities.outsideAlcohol !== undefined) {
      $set["amenities.outsideAlcohol"] = updates.amenities.outsideAlcohol;
    }
  }

  if (updates.photos && typeof updates.photos === "object") {
    for (const k of PHOTO_BUCKETS) {
      if (Array.isArray(updates.photos[k])) $set[`photos.${k}`] = updates.photos[k];
    }
  }

  if (updates.policies && typeof updates.policies === "object") {
    for (const k of POLICY_FIELDS) {
      if (updates.policies[k] !== undefined) $set[`policies.${k}`] = updates.policies[k];
    }
  }

  if (updates.contact && typeof updates.contact === "object") {
    for (const k of CONTACT_SCALARS) {
      if (updates.contact[k] !== undefined) $set[`contact.${k}`] = updates.contact[k];
    }
    if (Array.isArray(updates.contact.languages)) $set["contact.languages"] = updates.contact.languages;
  }

  return VenueRepository.updateBySlug(slug, $set);
};

module.exports = { getAllVenues, getVenueBySlug, updateVenueBySlug, createVenue };
