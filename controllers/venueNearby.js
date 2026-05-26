const Venue = require("../models/Venue");

const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY;
const CACHE_MS = 7 * 24 * 60 * 60 * 1000;

// Strict accommodation type allow-list — Google labels some dhabas/restaurants
// under `lodging` in India, so we narrow further by requiring one of these.
const ACCOMMODATION_TYPES = new Set([
  "lodging",
  "hotel",
  "motel",
  "resort",
  "guest_house",
  "hostel",
  "bed_and_breakfast",
  "extended_stay_hotel",
]);

// Names that almost always indicate a food venue mis-tagged as lodging.
const FOOD_NAME_RE = /\b(dhab+a|cafe|caf[eé]|restaurant|food|kitchen|bakery|bar|pub|rotti|tiffin|canteen|mess|biryani|adda|dosa|idli|chaat|sweets|mithai|lassi|juice|pizza|burger|veg|darshini|meals|eatery|dining)\b/i;

// Place-type signals for food venues — if present without `lodging`, drop it.
const FOOD_TYPES = new Set(["restaurant", "food", "bar", "cafe", "bakery"]);

function isAccommodation(place) {
  const name = place?.name || "";
  const types = Array.isArray(place?.types) ? place.types : [];
  if (FOOD_NAME_RE.test(name)) return false;
  const hasAccommodation = types.some((t) => ACCOMMODATION_TYPES.has(t));
  if (!hasAccommodation) return false;
  const hasFoodType = types.some((t) => FOOD_TYPES.has(t));
  if (hasFoodType && !types.includes("lodging")) return false;
  return true;
}

// Haversine distance between two lat/lng points, in km, rounded to 1 decimal.
function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371; // Earth's mean radius in km
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10;
}

const refreshNearby = async (req, res) => {
  try {
    const { slug } = req.params;
    const venue = await Venue.findOne({ slug });
    if (!venue) return res.status(404).json({ message: "Venue not found" });
    // Cache short-circuit
    if (venue.nearbyAccommodationRefreshedAt &&
        Date.now() - new Date(venue.nearbyAccommodationRefreshedAt).getTime() < CACHE_MS) {
      return res.status(200).json({ results: venue.nearbyAccommodation || [], cached: true });
    }
    const coords = venue.location?.coordinates;
    if (!Array.isArray(coords) || coords.length !== 2 || !GOOGLE_KEY) {
      return res.status(200).json({ results: [], skipped: true });
    }
    const [lng, lat] = coords;
    // type=lodging is the closest top-level category Google Places offers for
    // accommodation; we narrow further with the post-filter below.
    const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=5000&type=lodging&key=${GOOGLE_KEY}`;
    const resp = await fetch(url);
    const data = await resp.json();
    const results = (data.results || [])
      .filter(isAccommodation)
      .map((r) => {
        const pLat = r.geometry?.location?.lat;
        const pLng = r.geometry?.location?.lng;
        const distanceKm =
          typeof pLat === "number" && typeof pLng === "number"
            ? calculateDistance(lat, lng, pLat, pLng)
            : undefined;
        return {
          placeId: r.place_id,
          name: r.name,
          rating: typeof r.rating === "number" ? r.rating : undefined,
          vicinity: r.vicinity,
          priceLevel: typeof r.price_level === "number" ? r.price_level : undefined,
          photoReference: r.photos?.[0]?.photo_reference,
          distanceKm,
        };
      })
      .sort((a, b) => {
        // Closest first; entries without a distance go to the bottom.
        const ax = typeof a.distanceKm === "number" ? a.distanceKm : Infinity;
        const bx = typeof b.distanceKm === "number" ? b.distanceKm : Infinity;
        return ax - bx;
      })
      .slice(0, 6);
    // Use updateOne with $set so existing unrelated validation drift on the
    // venue doc (e.g. amenities.outsideAlcohol: "") doesn't block this
    // partial enrichment write.
    await Venue.updateOne(
      { _id: venue._id },
      { $set: { nearbyAccommodation: results, nearbyAccommodationRefreshedAt: new Date() } }
    );
    return res.status(200).json({ results });
  } catch (err) {
    return res.status(200).json({ results: [], error: err.message });
  }
};

module.exports = { refreshNearby };
