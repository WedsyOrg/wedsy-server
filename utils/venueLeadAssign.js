/**
 * utils/venueLeadAssign.js — VENUE-SCOPED lead assignment (MB-CRM S0a/S0d).
 *
 * Deliberately standalone: it must NEVER import or extend the platform
 * services/LeadAssignmentService.js (that one is Admin/Enquiry-scoped and
 * cross-team locked). This implements the assignment contract shared with OS:
 *   - an explicit assignee ALWAYS wins over auto round-robin;
 *   - manual create defaults to the creator (a member);
 *   - the target must be an ACTIVE member of THIS venue, else 422 / reject;
 *   - a lead is never parked on a disabled/inactive member.
 *
 * Round-robin has NO persistent rotation state (so an explicit assignment can't
 * perturb it): it load-balances by picking the active Sales member currently
 * holding the FEWEST non-terminal leads (ties → earliest-joined).
 */
const mongoose = require("mongoose");
const VenueTeamMember = require("../models/VenueTeamMember");
const VenueEnquiry = require("../models/VenueEnquiry");

// Validate that `id` is an active VenueTeamMember of `venueId`.
// Returns { ok, id } or { ok:false, message }.
async function validateAssignable(venueId, id) {
  if (!id || !mongoose.isValidObjectId(id)) {
    return { ok: false, message: "Assignee is not a valid member id" };
  }
  const member = await VenueTeamMember.findOne({ _id: id, venueId, isActive: true })
    .select("_id")
    .lean();
  if (!member) return { ok: false, message: "Assignee must be an active member of this venue" };
  return { ok: true, id: member._id };
}

// Load-balanced round-robin across the active Sales pool. Falls back to the full
// active-member pool when no one carries the legacy "sales" role, so auto-assign
// never silently drops a lead into the void (mirrors the intake-never-dies rule).
// Returns a VenueTeamMember _id or null when there is genuinely no one active.
async function pickRoundRobinAssignee(venueId) {
  let pool = await VenueTeamMember.find({ venueId, isActive: true, role: "sales" })
    .select("_id createdAt")
    .sort({ createdAt: 1 })
    .lean();
  if (pool.length === 0) {
    pool = await VenueTeamMember.find({ venueId, isActive: true })
      .select("_id createdAt")
      .sort({ createdAt: 1 })
      .lean();
  }
  if (pool.length === 0) return null;

  const poolIds = pool.map((m) => m._id);
  const counts = await VenueEnquiry.aggregate([
    {
      $match: {
        venueId: new mongoose.Types.ObjectId(String(venueId)),
        deleted: { $ne: true },
        assignedTo: { $in: poolIds },
        stage: { $nin: ["booked", "lost"] },
      },
    },
    { $group: { _id: "$assignedTo", n: { $sum: 1 } } },
  ]);
  const load = new Map(counts.map((c) => [String(c._id), c.n]));

  // pool is pre-sorted by createdAt asc, so the first minimum wins the tie.
  let best = pool[0];
  let bestN = load.get(String(pool[0]._id)) || 0;
  for (const m of pool) {
    const n = load.get(String(m._id)) || 0;
    if (n < bestN) {
      best = m;
      bestN = n;
    }
  }
  return best._id;
}

/**
 * Resolve the assignee for a CREATE, per the contract precedence.
 * @param {ObjectId} venueId
 * @param {*} requested        explicit assignee from the request (may be blank)
 * @param {ObjectId|null} creatorMemberId  the creating member (null for owner/inbound)
 * @param {boolean} autoAssign venue setting
 * @returns { assignedTo, via, auto } OR { error:{ status, message } }
 *
 * NOTE (EDGE 1): validation happens immediately before the caller's create(),
 * so the validate→apply window is negligible. If the creator flips inactive
 * mid-session we fall through to auto/unassigned rather than parking the lead.
 */
async function resolveCreateAssignment({ venueId, requested, creatorMemberId, autoAssign }) {
  const hasRequested = requested != null && String(requested).trim() !== "";
  // 1. explicit request wins — reject the whole create if it isn't assignable.
  if (hasRequested) {
    const v = await validateAssignable(venueId, requested);
    if (!v.ok) return { error: { status: 422, message: v.message } };
    return { assignedTo: v.id, via: "create_override", auto: false };
  }
  // 2. manual create defaults to the creator (overrides auto-assign).
  if (creatorMemberId) {
    const v = await validateAssignable(venueId, creatorMemberId);
    if (v.ok) return { assignedTo: v.id, via: "create_self", auto: false };
    // creator no longer assignable → fall through (EDGE 1).
  }
  // 3. auto round-robin when the venue opted in and no explicit/creator target.
  if (autoAssign) {
    const id = await pickRoundRobinAssignee(venueId);
    if (id) return { assignedTo: id, via: "round_robin", auto: true };
  }
  // 4. unassigned.
  return { assignedTo: null, via: null, auto: false };
}

module.exports = { validateAssignable, pickRoundRobinAssignee, resolveCreateAssignment };
