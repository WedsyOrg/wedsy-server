/**
 * controllers/venueOwnerReviews.js — Phase 4.2 owner-facing reviews.
 * GET serves from the 24h venue-doc cache (fetching when stale); the manual
 * refresh endpoint forces a fetch and is rate-limited at the router to
 * respect the Places quota. DISPLAY + MONITOR + REQUEST only — replying to
 * Google reviews needs the GBP API/OAuth (future, flagged in the UI).
 */
const Venue = require("../models/Venue");
const { getVenueReviews } = require("../utils/venueGoogleReviews");

async function resolveOwnedVenue(req, res) {
  const venue = await Venue.findOne({ slug: req.params.slug })
    .select("_id googlePlaceId googleRating googleReviewCount googleReviews googleReviewsRefreshedAt")
    .lean();
  if (!venue) { res.status(404).json({ message: "Venue not found" }); return null; }
  if (String(venue._id) !== String(req.venueOwner.venueId)) { res.status(403).json({ message: "Forbidden" }); return null; }
  return venue;
}

function shape(out, venue) {
  return {
    hasPlaceId: Boolean(venue.googlePlaceId),
    // The owner's own place id — powers the "write a review" link in requests.
    placeId: venue.googlePlaceId || null,
    rating: out.rating,
    count: out.count,
    reviews: out.reviews,
    refreshedAt: out.refreshedAt,
    cached: Boolean(out.cached),
    skipped: out.skipped || undefined,
  };
}

// GET /venues/:slug/reviews — venueOwnerAuth (open read; 24h cache).
const getReviews = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const out = await getVenueReviews(venue, {
      save: (setFields) => Venue.updateOne({ _id: venue._id }, { $set: setFields }),
    });
    return res.status(200).json(shape(out, venue));
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

// POST /venues/:slug/reviews/refresh — venueOwnerAuth + rate limit (router).
const refreshOwnerReviews = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    if (!venue.googlePlaceId) {
      return res.status(409).json({ message: "Set your Google Place first (My Listing → location)" });
    }
    const out = await getVenueReviews(venue, {
      force: true,
      save: (setFields) => Venue.updateOne({ _id: venue._id }, { $set: setFields }),
    });
    return res.status(200).json(shape(out, venue));
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

module.exports = { getReviews, refreshOwnerReviews };
