/**
 * scripts/e2e-reviews-cache.js — deterministic checks for the Google-reviews
 * cache seam (utils/venueGoogleReviews). No server, no DB, no network: the
 * fetch is stubbed at the util's injection point, exactly how creds-blank
 * automated runs stay offline.
 *
 * Usage: node scripts/e2e-reviews-cache.js
 */
let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`✓ PASS  ${name}`);
  } else {
    fail++;
    console.log(`✗ FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const GOOGLE_BODY = {
  result: {
    rating: 4.6,
    user_ratings_total: 132,
    reviews: [{ author_name: "Asha", rating: 5, text: "Beautiful venue!", time: 1700000000 }],
  },
};

function stubFetch(calls) {
  return async (url) => {
    calls.push(url);
    return { json: async () => GOOGLE_BODY };
  };
}

async function run() {
  const { getVenueReviews, fetchPlaceReviews } = require("../utils/venueGoogleReviews");

  // 1. Fresh cache (refreshed 1h ago, 24h TTL) → served from the doc, NO fetch.
  {
    const calls = [];
    const venue = {
      googlePlaceId: "place-1",
      googleRating: 4.4,
      googleReviewCount: 120,
      googleReviews: [{ authorName: "Cached", rating: 4, text: "old" }],
      googleReviewsRefreshedAt: new Date(Date.now() - 60 * 60 * 1000),
    };
    const out = await getVenueReviews(venue, { fetchImpl: stubFetch(calls), key: "k" });
    check("fresh cache -> cached:true, zero Google calls", out.cached === true && out.rating === 4.4 && calls.length === 0, JSON.stringify({ out, calls: calls.length }));
  }

  // 2. Stale cache (25h ago) → exactly one fetch, values updated, save() called.
  {
    const calls = [];
    const saved = [];
    const venue = {
      googlePlaceId: "place-1",
      googleRating: 4.4,
      googleReviewsRefreshedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    };
    const out = await getVenueReviews(venue, { fetchImpl: stubFetch(calls), key: "k", save: (f) => saved.push(f) });
    check(
      "stale cache -> one fetch, updated values persisted",
      calls.length === 1 && out.rating === 4.6 && out.count === 132 && out.reviews.length === 1 && saved.length === 1 && saved[0].googleRating === 4.6,
      JSON.stringify({ calls: calls.length, out: { rating: out.rating, count: out.count }, saved: saved.length })
    );
  }

  // 3. force:true bypasses a fresh cache (manual refresh path).
  {
    const calls = [];
    const venue = { googlePlaceId: "place-1", googleRating: 4.4, googleReviewsRefreshedAt: new Date() };
    const out = await getVenueReviews(venue, { force: true, fetchImpl: stubFetch(calls), key: "k", save: () => {} });
    check("force refresh bypasses TTL", calls.length === 1 && out.rating === 4.6, `calls=${calls.length}`);
  }

  // 4. No placeId → skipped, never fetches.
  {
    const calls = [];
    const out = await getVenueReviews({ googlePlaceId: "" }, { fetchImpl: stubFetch(calls), key: "k" });
    check("no placeId -> skipped, zero calls", out.skipped === "no placeId" && calls.length === 0, JSON.stringify(out));
  }

  // 5. Creds blank → skipped, never fetches (automated-run safety).
  {
    const calls = [];
    const venue = { googlePlaceId: "place-1", googleReviewsRefreshedAt: new Date(Date.now() - 48 * 60 * 60 * 1000) };
    const out = await getVenueReviews(venue, { fetchImpl: stubFetch(calls), key: "" });
    check("blank key -> skipped, zero calls", /no GOOGLE/.test(out.skipped || "") && calls.length === 0, JSON.stringify({ out, calls: calls.length }));
  }

  // 6. fetchPlaceReviews caps stored reviews at 5.
  {
    const many = { result: { rating: 4, user_ratings_total: 9, reviews: Array.from({ length: 8 }, (_, i) => ({ author_name: `A${i}`, rating: 5, text: "x" })) } };
    const out = await fetchPlaceReviews("p", { fetchImpl: async () => ({ json: async () => many }), key: "k" });
    check("review list capped at 5", out.reviews.length === 5, `n=${out.reviews.length}`);
  }

  console.log(`\n[e2e-reviews-cache] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
