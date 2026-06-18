/**
 * utils/venueGoogleReviews.js — owner-facing Google rating/reviews with the
 * Venue doc as the cache (googleRating / googleReviewCount / googleReviews /
 * googleReviewsRefreshedAt — the same fields the couple-side enrichment
 * already maintains, so there is ONE source of truth, no parallel cache doc).
 *
 * The Google fetch is injectable (fetchImpl) so suites can stub the seam and
 * creds-blank automated runs never call out: no GOOGLE_PLACES_API_KEY or no
 * placeId → { skipped }.
 */
const OWNER_TTL_MS = 24 * 60 * 60 * 1000; // 24h owner-surface cache

async function fetchPlaceReviews(placeId, { fetchImpl = fetch, key = process.env.GOOGLE_PLACES_API_KEY } = {}) {
  if (!placeId) return { skipped: "no placeId" };
  if (!key) return { skipped: "no GOOGLE_PLACES_API_KEY" };
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=reviews,rating,user_ratings_total&key=${key}`;
  const resp = await fetchImpl(url);
  const data = await resp.json();
  const result = (data && data.result) || {};
  return {
    rating: typeof result.rating === "number" ? result.rating : null,
    count: typeof result.user_ratings_total === "number" ? result.user_ratings_total : null,
    reviews: (result.reviews || []).slice(0, 5).map((r) => ({
      authorName: r.author_name,
      rating: r.rating,
      text: r.text,
      time: r.time,
      profilePhotoUrl: r.profile_photo_url,
    })),
  };
}

/**
 * Cached-or-fetch against the venue doc. `venue` must carry googlePlaceId and
 * the cache fields; `save(setFields)` persists (injectable for tests).
 * Returns { rating, count, reviews, refreshedAt, cached?, skipped? }.
 */
async function getVenueReviews(venue, { force = false, ttlMs = OWNER_TTL_MS, fetchImpl, key, save } = {}) {
  const fromDoc = () => ({
    rating: venue.googleRating ?? null,
    count: venue.googleReviewCount ?? null,
    reviews: venue.googleReviews || [],
    refreshedAt: venue.googleReviewsRefreshedAt || null,
  });

  if (!venue.googlePlaceId) return { ...fromDoc(), skipped: "no placeId" };

  const fresh =
    venue.googleReviewsRefreshedAt &&
    Date.now() - new Date(venue.googleReviewsRefreshedAt).getTime() < ttlMs;
  if (fresh && !force) return { ...fromDoc(), cached: true };

  const fetched = await fetchPlaceReviews(venue.googlePlaceId, { fetchImpl, key });
  if (fetched.skipped) return { ...fromDoc(), skipped: fetched.skipped };

  const setFields = {
    googleReviews: fetched.reviews,
    googleReviewsRefreshedAt: new Date(),
  };
  if (typeof fetched.rating === "number") setFields.googleRating = fetched.rating;
  if (typeof fetched.count === "number") setFields.googleReviewCount = fetched.count;
  if (typeof save === "function") await save(setFields);

  return {
    rating: setFields.googleRating ?? venue.googleRating ?? null,
    count: setFields.googleReviewCount ?? venue.googleReviewCount ?? null,
    reviews: fetched.reviews,
    refreshedAt: setFields.googleReviewsRefreshedAt,
  };
}

module.exports = { fetchPlaceReviews, getVenueReviews, OWNER_TTL_MS };
