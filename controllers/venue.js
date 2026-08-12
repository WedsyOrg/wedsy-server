const VenueService = require("../services/VenueService");
const { verifiedBadge, partnerBadge } = require("../utils/venueTracks");

const getVenues = async (req, res) => {
  try {
    const { status, limit = 100, skip = 0, zone, area, search, venueType, amenities, veg, nonVeg, minCapacity, minPrice, maxPrice, sort } = req.query;
    // Admin: use the status query as-is (undefined = all statuses, no filter).
    // Non-admin (public/couples): keep the current default-to-published behavior.
    const effectiveStatus = req.admin ? status : status || "published";
    const trimmed = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const result = await VenueService.getAllVenues({
      status: effectiveStatus,
      limit: parseInt(limit),
      skip: parseInt(skip),
      zone: trimmed(zone),
      area: trimmed(area),
      search: trimmed(search),
      venueType: trimmed(venueType),
      amenities: trimmed(amenities),
      veg, nonVeg,
      minCapacity: trimmed(minCapacity),
      minPrice: trimmed(minPrice),
      maxPrice: trimmed(maxPrice),
      sort: trimmed(sort),
    });
    // MB-OSV S0 — the two derived badges, same implementation as the detail
    // response and the admin reads (utils/venueTracks). `isVerified` keeps its
    // API name exactly as promised when it was derived from status, so the
    // couple-side frontend needed no change; only the derivation moved.
    const venues = (result.venues || []).map((v) => ({
      ...v,
      isVerified: verifiedBadge(v),
      isPartner: partnerBadge(v),
    }));
    return res.status(200).json({ ...result, venues });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Backward-compatible structured policies. If policyDoc has no content yet,
// migrate the legacy `policies` object into it on read (never lost):
//   otherRestrictions -> policyDoc.policies, cancellation+refund -> policyDoc.refund.
function withPolicyDoc(venue) {
  if (!venue) return venue;
  const pd = venue.policyDoc || {};
  const has = (a) => Array.isArray(a) && a.length > 0;
  if (has(pd.policies) || has(pd.terms) || has(pd.refund)) {
    venue.policyDoc = { policies: pd.policies || [], terms: pd.terms || [], refund: pd.refund || [] };
    return venue;
  }
  const legacy = venue.policies || {};
  const clean = (...vals) => vals.map((s) => (s == null ? "" : String(s).trim())).filter(Boolean);
  venue.policyDoc = {
    policies: clean(legacy.otherRestrictions),
    terms: [],
    refund: clean(legacy.cancellation, legacy.refund),
  };
  return venue;
}

const getVenueBySlug = async (req, res) => {
  try {
    const { slug } = req.params;
    const venue = withPolicyDoc(await VenueService.getVenueBySlug(slug));
    // Public detail exposes the aggregate rating + count ONLY — individual
    // Google review texts are an owner-dashboard surface, not a public API.
    if (venue) {
      delete venue.googleReviews;
      delete venue.googleReviewsRefreshedAt;
    }
    // MB-OSV S0 — this is the change that comment anticipated. Verification is
    // now a real orthogonal boolean (verified.isVerified) instead of a reading
    // of the publication status, and the derivation lives in ONE place for the
    // public read, the browse list and every admin surface. The `isVerified`
    // API name is unchanged, so the couple-side frontend needed zero change.
    //
    // isPartner joins it: granted access AND a first owner sign-in. The two are
    // independent — a venue can carry either badge without the other.
    const isVerified = verifiedBadge(venue);
    const isPartner = partnerBadge(venue);
    return res.status(200).json({ venue, isVerified, isPartner });
  } catch (err) {
    if (err.message === "Venue not found") {
      return res.status(404).json({ message: "Venue not found" });
    }
    return res.status(500).json({ message: err.message });
  }
};

const updateVenue = async (req, res) => {
  try {
    const { slug } = req.params;
    // Admin: bypass the venue-ownership check by resolving the venue's own _id and
    // passing it as the owner id (so the service check passes) — no service change.
    // Non-admin (venue_owner): keep the existing ownership check via req.venueOwner.venueId.
    let ownerVenueId;
    if (req.admin) {
      const existing = await VenueService.getVenueBySlug(slug);
      ownerVenueId = existing._id;
    } else {
      ownerVenueId = req.venueOwner.venueId;
    }
    // D10: identify the actor so the activity spine records who changed what.
    const { actorFromReq } = require("../utils/venueActivity");
    const actor = await actorFromReq(req);
    const venue = await VenueService.updateVenueBySlug(
      slug,
      ownerVenueId,
      req.body || {},
      actor
    );
    return res.status(200).json({ venue });
  } catch (err) {
    if (err.message === "Venue not found") return res.status(404).json({ message: err.message });
    if (err.message === "Forbidden") return res.status(403).json({ message: err.message });
    return res.status(500).json({ message: err.message });
  }
};

const createVenue = async (req, res) => {
  try {
    const venue = await VenueService.createVenue(req.body || {});
    return res.status(201).json({ venue });
  } catch (err) {
    if (err.status === 400 || err.name === "ValidationError") {
      return res.status(400).json({ message: err.message });
    }
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { getVenues, getVenueBySlug, updateVenue, createVenue };
