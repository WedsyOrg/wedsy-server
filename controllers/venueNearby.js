const Venue = require("../models/Venue");

const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY;
const CACHE_MS = 7 * 24 * 60 * 60 * 1000;

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
    const results = (data.results || []).slice(0, 6).map(r => ({
      placeId: r.place_id,
      name: r.name,
      rating: typeof r.rating === "number" ? r.rating : undefined,
      vicinity: r.vicinity,
      priceLevel: typeof r.price_level === "number" ? r.price_level : undefined,
      photoReference: r.photos?.[0]?.photo_reference,
    }));
    venue.nearbyAccommodation = results;
    venue.nearbyAccommodationRefreshedAt = new Date();
    await venue.save();
    return res.status(200).json({ results });
  } catch (err) {
    return res.status(200).json({ results: [], error: err.message });
  }
};

module.exports = { refreshNearby };
