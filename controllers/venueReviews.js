/**
 * controllers/venueReviews.js — couple-side Google reviews enrichment route
 * (POST /venues/:slug/reviews, public + rate-limited).
 *
 * The fetch + cache logic now lives in utils/venueGoogleReviews (shared with
 * the owner-facing reviews controller — one source of truth). This route keeps
 * its historical 7-day TTL and its legacy response shape
 * ({ reviews, rating, total, cached?/skipped?/error? }) so existing callers are
 * unaffected.
 */
const Venue = require("../models/Venue");
const { getVenueReviews } = require("../utils/venueGoogleReviews");

const CACHE_MS = 7 * 24 * 60 * 60 * 1000; // couple-side TTL (longer than the owner surface)

const refreshReviews = async (req, res) => {
  try {
    const { slug } = req.params;
    const venue = await Venue.findOne({ slug })
      .select("_id googlePlaceId googleRating googleReviewCount googleReviews googleReviewsRefreshedAt")
      .lean();
    if (!venue) return res.status(404).json({ message: "Venue not found" });

    const out = await getVenueReviews(venue, {
      ttlMs: CACHE_MS,
      // $set keeps unrelated validation drift on the venue doc from blocking
      // this partial enrichment write (mirrors the previous behaviour).
      save: (setFields) => Venue.updateOne({ _id: venue._id }, { $set: setFields }),
    });

    // Preserve the legacy public shape exactly: a skipped result (no placeId or
    // no Google key) returns empty values, never partial cached data.
    if (out.skipped) {
      return res.status(200).json({ reviews: [], rating: null, total: 0, skipped: true });
    }
    return res.status(200).json({
      reviews: out.reviews || [],
      rating: out.rating ?? null,
      total: out.count ?? 0,
      ...(out.cached ? { cached: true } : {}),
    });
  } catch (err) {
    return res.status(200).json({ reviews: [], rating: null, total: 0, error: err.message });
  }
};

module.exports = { refreshReviews };
