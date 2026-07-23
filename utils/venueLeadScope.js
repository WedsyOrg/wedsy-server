/**
 * utils/venueLeadScope.js — the ONE place lead visibility is decided.
 *
 * Rule (S0d): a member WITHOUT leads_view_all may only see/act on leads assigned
 * to themselves; everyone with the cap (and owners) sees all. Soft-deleted leads
 * are excluded everywhere. Every lead-resolving path routes through this so the
 * boundary can never drift route-by-route (the MB-V2 sibling-inference gap).
 *
 * A miss returns null / 404 semantics (never 403) so existence is not leaked,
 * matching getEnquiryById's established behaviour.
 */
const VenueEnquiry = require("../models/VenueEnquiry");
const { hasCapability } = require("./venueRbac");

async function canViewAllLeads(venueOwner, venueMember) {
  return hasCapability(venueOwner, "leads_view_all", venueMember);
}

// Build the base query fragment for lead reads/aggregates: venue-bound,
// soft-delete-excluded, and assignee-scoped when leads_view_all is absent.
// `extra` merges in additional constraints (e.g. { _id }, { stage: {$ne} }).
async function scopedLeadFilter(venueOwner, venueMember, venueId, extra = {}) {
  const filter = { venueId, deleted: { $ne: true }, ...extra };
  if (!(await canViewAllLeads(venueOwner, venueMember))) {
    filter.assignedTo = venueOwner.memberId || null;
  }
  return filter;
}

// Resolve a single lead through the scoped filter. Returns the query (await it):
// a Mongoose doc (default) or lean POJO, optionally with select/populate. Null
// when the lead does not exist OR is out of the requester's scope.
async function resolveScopedEnquiry(venueOwner, venueMember, venueId, enquiryId, opts = {}) {
  const filter = await scopedLeadFilter(venueOwner, venueMember, venueId, { _id: enquiryId });
  let q = VenueEnquiry.findOne(filter);
  if (opts.select) q = q.select(opts.select);
  if (opts.populate) q = q.populate(opts.populate);
  if (opts.lean) q = q.lean();
  return q;
}

module.exports = { canViewAllLeads, scopedLeadFilter, resolveScopedEnquiry };
