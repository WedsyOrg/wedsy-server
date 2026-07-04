/**
 * controllers/venueCompetitive.js — Phase 4.3 competitor insights (privacy-safe).
 *
 * GET /venues/:slug/competitive (venueOwnerAuth, open read) returns the venue's
 * own numbers vs ANONYMIZED zone-cohort aggregates. Hard rules:
 *   - aggregates only; NEVER any per-competitor venue data leaves this file.
 *   - cohort = published venues in the same zone (falls back to locality when
 *     zone is the unset sentinel "").
 *   - any metric whose cohort has fewer than MIN_COHORT (5) venues is
 *     suppressed: { suppressed: true, minCohort: 5 }.
 * Cached 24h on the venue doc (competitiveCache).
 */
const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueView = require("../models/VenueView");

const MIN_COHORT = 5;
const CACHE_MS = 24 * 60 * 60 * 1000;

async function resolveOwnedVenue(req, res) {
  const venue = await Venue.findOne({ slug: req.params.slug })
    .select("_id zone locality pricing googleRating competitiveCache")
    .lean();
  if (!venue) { res.status(404).json({ message: "Venue not found" }); return null; }
  if (String(venue._id) !== String(req.venueOwner.venueId)) { res.status(403).json({ message: "Forbidden" }); return null; }
  return venue;
}

const round1 = (n) => Math.round(n * 10) / 10;
const avg = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0);

// Linear-interpolation percentile over a sorted numeric array.
function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

function suppressed() {
  return { suppressed: true, minCohort: MIN_COHORT };
}

async function computeCompetitive(venue) {
  // Cohort: published venues sharing the zone (or locality when zone unset).
  const cohortFilter = { status: "published" };
  if (venue.zone) cohortFilter.zone = venue.zone;
  else if (venue.locality) cohortFilter.locality = venue.locality;
  else return { cohortKey: null, cohortSize: 0, suppressedAll: true, metrics: null };

  const cohort = await Venue.find(cohortFilter)
    .select("_id pricing googleRating")
    .lean();
  const cohortIds = cohort.map((v) => v._id);
  const cohortSize = cohort.length;

  const now = Date.now();
  const d30 = new Date(now - 30 * 86400000);
  const d90 = new Date(now - 90 * 86400000);
  const selfId = String(venue._id);

  // One aggregation over the cohort's enquiries → per-venue counts.
  const enqAgg = await VenueEnquiry.aggregate([
    { $match: { venueId: { $in: cohortIds } } },
    {
      $group: {
        _id: "$venueId",
        total: { $sum: 1 },
        c30: { $sum: { $cond: [{ $gte: ["$createdAt", d30] }, 1, 0] } },
        c90: { $sum: { $cond: [{ $gte: ["$createdAt", d90] }, 1, 0] } },
        booked: { $sum: { $cond: [{ $eq: ["$stage", "booked"] }, 1, 0] } },
      },
    },
  ]);
  const enqById = new Map(enqAgg.map((r) => [String(r._id), r]));

  // Views per cohort venue (all-time) → view→enquiry conversion where present.
  const viewAgg = await VenueView.aggregate([
    { $match: { venueId: { $in: cohortIds } } },
    { $group: { _id: "$venueId", views: { $sum: 1 } } },
  ]);
  const viewsById = new Map(viewAgg.map((r) => [String(r._id), r.views]));

  const enq = (id) => enqById.get(id) || { total: 0, c30: 0, c90: 0, booked: 0 };
  const cohortEnoughForMetric = cohortSize >= MIN_COHORT;

  // ── avg enquiries / venue (30d, 90d) ──
  const enquiries =
    cohortEnoughForMetric
      ? {
          you30: enq(selfId).c30,
          cohortAvg30: round1(avg(cohort.map((v) => enq(String(v._id)).c30))),
          you90: enq(selfId).c90,
          cohortAvg90: round1(avg(cohort.map((v) => enq(String(v._id)).c90))),
        }
      : suppressed();

  // ── view → enquiry conversion (only venues that HAVE views) ──
  const withViews = cohort.filter((v) => (viewsById.get(String(v._id)) || 0) > 0);
  const convRate = (v) => {
    const views = viewsById.get(String(v._id)) || 0;
    return views > 0 ? Math.min(100, (enq(String(v._id)).total / views) * 100) : null;
  };
  const youViews = viewsById.get(selfId) || 0;
  const conversion =
    withViews.length >= MIN_COHORT
      ? {
          you: youViews > 0 ? round1(convRate(venue) ?? 0) : null,
          cohortAvg: round1(avg(withViews.map((v) => convRate(v)).filter((x) => x != null))),
        }
      : suppressed();

  // ── enquiry → booked rate ──
  const bookedRate = (v) => {
    const e = enq(String(v._id));
    return e.total > 0 ? (e.booked / e.total) * 100 : 0;
  };
  const youEnq = enq(selfId);
  const booking =
    cohortEnoughForMetric
      ? {
          you: youEnq.total > 0 ? round1((youEnq.booked / youEnq.total) * 100) : null,
          cohortAvg: round1(avg(cohort.map((v) => bookedRate(v)))),
        }
      : suppressed();

  // ── price positioning: perPlate.veg vs cohort median / quartiles ──
  const vegPrices = cohort
    .map((v) => Number(v.pricing && v.pricing.perPlate && v.pricing.perPlate.veg) || 0)
    .filter((x) => x > 0)
    .sort((a, b) => a - b);
  const youVeg = Number(venue.pricing && venue.pricing.perPlate && venue.pricing.perPlate.veg) || 0;
  const price =
    vegPrices.length >= MIN_COHORT
      ? {
          you: youVeg || null,
          cohortMedian: Math.round(percentile(vegPrices, 0.5)),
          cohortQ1: Math.round(percentile(vegPrices, 0.25)),
          cohortQ3: Math.round(percentile(vegPrices, 0.75)),
          // Where the venue sits: below_q1 / mid / above_q3 (null if no own price).
          position:
            youVeg <= 0
              ? null
              : youVeg < percentile(vegPrices, 0.25)
              ? "below_q1"
              : youVeg > percentile(vegPrices, 0.75)
              ? "above_q3"
              : "mid",
        }
      : suppressed();

  // ── average Google rating vs cohort ──
  const ratings = cohort.map((v) => Number(v.googleRating)).filter((x) => x > 0);
  const rating =
    ratings.length >= MIN_COHORT
      ? {
          you: Number(venue.googleRating) > 0 ? round1(Number(venue.googleRating)) : null,
          cohortAvg: round1(avg(ratings)),
        }
      : suppressed();

  return {
    cohortKey: venue.zone || venue.locality || null,
    cohortSize,
    suppressedAll: false,
    minCohort: MIN_COHORT,
    metrics: { enquiries, conversion, booking, price, rating },
  };
}

// GET /venues/:slug/competitive — venueOwnerAuth (open read; 24h cache).
const getCompetitive = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;

    const cache = venue.competitiveCache;
    const fresh = cache && cache.computedAt && Date.now() - new Date(cache.computedAt).getTime() < CACHE_MS && cache.payload;
    if (fresh && req.query.refresh !== "1") {
      return res.status(200).json({ ...cache.payload, cached: true });
    }

    const payload = await computeCompetitive(venue);
    await Venue.updateOne({ _id: venue._id }, { $set: { competitiveCache: { computedAt: new Date(), payload } } });
    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { getCompetitive, computeCompetitive, percentile, MIN_COHORT };
