const Venue = require("../models/Venue");

const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY;
const CACHE_MS = 7 * 24 * 60 * 60 * 1000;

const refreshReviews = async (req, res) => {
  try {
    const { slug } = req.params;
    const venue = await Venue.findOne({ slug });
    if (!venue) return res.status(404).json({ message: "Venue not found" });
    if (!venue.googlePlaceId) {
      return res.status(200).json({ reviews: [], rating: null, total: 0, skipped: true });
    }
    if (venue.googleReviewsRefreshedAt &&
        Date.now() - new Date(venue.googleReviewsRefreshedAt).getTime() < CACHE_MS) {
      return res.status(200).json({
        reviews: venue.googleReviews || [],
        rating: venue.googleRating,
        total: venue.googleReviewCount,
        cached: true,
      });
    }
    if (!GOOGLE_KEY) {
      return res.status(200).json({ reviews: [], rating: null, total: 0, skipped: true });
    }
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${venue.googlePlaceId}&fields=reviews,rating,user_ratings_total&key=${GOOGLE_KEY}`;
    const resp = await fetch(url);
    const data = await resp.json();
    const reviews = (data?.result?.reviews || []).slice(0, 5).map(r => ({
      authorName: r.author_name,
      rating: r.rating,
      text: r.text,
      time: r.time,
      profilePhotoUrl: r.profile_photo_url,
    }));
    // Use updateOne with $set so existing unrelated validation drift on the
    // venue doc (e.g. amenities.outsideAlcohol: "") doesn't block this
    // partial enrichment write.
    const setFields = { googleReviews: reviews, googleReviewsRefreshedAt: new Date() };
    if (typeof data?.result?.rating === "number") setFields.googleRating = data.result.rating;
    if (typeof data?.result?.user_ratings_total === "number") setFields.googleReviewCount = data.result.user_ratings_total;
    await Venue.updateOne({ _id: venue._id }, { $set: setFields });
    return res.status(200).json({
      reviews,
      rating: setFields.googleRating ?? venue.googleRating ?? null,
      total: setFields.googleReviewCount ?? venue.googleReviewCount ?? 0,
    });
  } catch (err) {
    return res.status(200).json({ reviews: [], rating: null, total: 0, error: err.message });
  }
};

module.exports = { refreshReviews };
