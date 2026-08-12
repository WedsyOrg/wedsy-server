/**
 * utils/venueTracks.js — MB-OSV S0: the two-track venue model.
 *
 * Venue.status was carrying two unrelated questions at once:
 *   "is this listing publishable?"  and  "has Wedsy verified this venue?"
 * so a venue could not be verified-but-draft, and verification could not be
 * revoked without demoting the listing. The tracks are now separate:
 *
 *   TRACK A — DATA. Ours alone, no venue involvement. raw → enriching →
 *     enriched, terminating in verified.isVerified (an OS call).
 *   TRACK B — PARTNERSHIP. The commercial relationship. access granted →
 *     first owner login → onboarding → live partner.
 *
 * The tracks are INDEPENDENT: a venue can be verified and never approached, or
 * a signed partner whose data nobody has checked. Nothing here couples them.
 *
 * Both badges are DERIVED on every read and never stored — a denormalised copy
 * is a second source of truth that silently rots. This module is the single
 * implementation; model statics, controllers and tests all delegate here.
 */

// Track A stage vocabulary (derived from the enrichment subdoc, never stored).
const ENRICHMENT_STAGES = ["raw", "enriching", "enriched"];

// A venue is "enriched" at or above this curated-completeness score with no
// outstanding missingFields. Below it — but touched — it is "enriching".
const ENRICHED_MIN_COMPLETENESS = 80;

// Track B onboarding vocabulary.
const ONBOARDING_STATUSES = ["not_started", "in_progress", "complete"];

// The two ways Track B can start. Both run the SAME grant-access action; the
// trigger only records which door the venue came through.
const ACCESS_GRANT_TRIGGERS = ["claim_approval", "wedsy_select"];

// How a venue entered the directory at all (Track A entry point).
const ENTRY_POINTS = ["scraped", "claimed", "walk_up"];

/**
 * VERIFIED BADGE — Track A terminal state.
 *
 * Legacy fallback: before the S0 backfill, verification lived in
 * status === "verified". Un-backfilled docs still read correctly through this
 * fallback; scripts/backfill-venue-tracks.js retires it per document. New
 * writes NEVER set status = "verified" — status is publication lifecycle only.
 */
function verifiedBadge(venue) {
  if (!venue) return false;
  if (venue.verified && typeof venue.verified.isVerified === "boolean") {
    return venue.verified.isVerified;
  }
  return venue.status === "verified";
}

/**
 * PARTNER BADGE — Track B live state.
 *
 * Deliberately a conjunction: access granted is what WE did, first owner login
 * is what THEY did. Granting access to an account nobody ever signs into is a
 * partnership on paper only, and the badge must not claim otherwise. This is
 * the rule the S0 truth table pins down.
 */
function partnerBadge(venue) {
  if (!venue || !venue.partner) return false;
  return Boolean(venue.partner.accessGrantedAt) && Boolean(venue.partner.firstOwnerLoginAt);
}

/** Track A progression, derived from the enrichment subdoc. */
function enrichmentStage(venue) {
  const e = (venue && venue.enrichment) || {};
  if (!e.lastEnrichedAt) return "raw";
  const score = typeof e.completeness === "number" ? e.completeness : 0;
  const missing = Array.isArray(e.missingFields) ? e.missingFields.length : 0;
  return score >= ENRICHED_MIN_COMPLETENESS && missing === 0 ? "enriched" : "enriching";
}

/**
 * Track B position — the coarse partnership state, derived.
 * none → access_granted → live → onboarding_complete
 *
 * "live" is exactly the partner badge; onboarding runs after the venue is live
 * (they are already transacting while paperwork completes), so a complete
 * onboarding without a login is still NOT live.
 */
function partnerStage(venue) {
  const p = (venue && venue.partner) || {};
  if (!p.accessGrantedAt) return "none";
  if (!p.firstOwnerLoginAt) return "access_granted";
  const status = (p.onboarding && p.onboarding.status) || "not_started";
  return status === "complete" ? "onboarding_complete" : "live";
}

/**
 * WHY each badge is or isn't lit — rendered verbatim by the OS 360 screen so
 * the operator never has to guess which half of the conjunction is missing.
 */
function badgeReasons(venue) {
  const p = (venue && venue.partner) || {};
  const v = (venue && venue.verified) || {};
  const isVerified = verifiedBadge(venue);
  const isPartner = partnerBadge(venue);
  return {
    verified: {
      lit: isVerified,
      reason: isVerified
        ? v.verifiedAt
          ? "Verified by the Wedsy team."
          : "Verified (legacy status, pre-dates the two-track split)."
        : "Not verified yet — a Wedsy team member must confirm this venue.",
    },
    partner: {
      lit: isPartner,
      reason: isPartner
        ? "Access granted and the owner has signed in."
        : !p.accessGrantedAt
          ? "Partner access has not been granted yet."
          : "Access granted, but the owner has never signed in.",
    },
  };
}

/** Everything the read surfaces need, in one shape. */
function trackSummary(venue) {
  return {
    verifiedBadge: verifiedBadge(venue),
    partnerBadge: partnerBadge(venue),
    enrichmentStage: enrichmentStage(venue),
    partnerStage: partnerStage(venue),
    reasons: badgeReasons(venue),
  };
}

module.exports = {
  ENRICHMENT_STAGES,
  ENRICHED_MIN_COMPLETENESS,
  ONBOARDING_STATUSES,
  ACCESS_GRANT_TRIGGERS,
  ENTRY_POINTS,
  verifiedBadge,
  partnerBadge,
  enrichmentStage,
  partnerStage,
  badgeReasons,
  trackSummary,
};
