const Venue = require("../models/Venue");

const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY;
const CACHE_MS = 7 * 24 * 60 * 60 * 1000;

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
    const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=5000&type=lodging&key=${GOOGLE_KEY}`;
    const resp = await fetch(url);
    const data = await resp.json();
    const results = (data.results || []).slice(0, 6).map(r => {
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
    });
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
