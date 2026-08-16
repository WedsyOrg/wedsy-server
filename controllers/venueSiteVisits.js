/**
 * controllers/venueSiteVisits.js — site visits, owner side.
 *
 * Originally MB-V2 P1: read + status-move only, because visits were created
 * wedsy-side by the planner. That left the owner's own walk-throughs with no
 * home — the workbench's "Schedule a visit" affordance could only write a
 * timeline note and a reminder, never a real visit. This is the full lifecycle.
 *
 * SCOPE: a site visit is LEAD-DERIVED data (it carries the couple's name and
 * phone through enquiryRef). Every read and write therefore resolves the parent
 * lead through utils/venueLeadScope, so a member without leads_view_all can
 * neither list nor touch a visit belonging to another member's lead. Before
 * this, listOwnSiteVisits filtered on { venue } alone and populated
 * coupleName/couplePhone — a scoped Sales member could read every couple in
 * the venue through it (invariant #5 violation).
 */
const mongoose = require("mongoose");
const Venue = require("../models/Venue");
const VenueSiteVisit = require("../models/VenueSiteVisit");
const VenueEnquiry = require("../models/VenueEnquiry");
const { resolveScopedEnquiry, scopedLeadFilter } = require("../utils/venueLeadScope");
const { hasCapability } = require("../utils/venueRbac");
const { optDate, optStr, MAXLEN } = require("../utils/venueInput");
const { venueDayBounds, venueDueBucket, venueDateTimeLabel } = require("../utils/venueTime");

const STATUSES = ["scheduled", "confirmed", "completed", "cancelled"];
// BUILD — how the visit WENT, which `status` never answered. Logging one is
// the single most valuable thing an owner can do after a walk-through, and it
// implies the appointment happened, so it completes the visit in the same tap.
const OUTCOMES = ["came", "no_show", "went_well", "too_expensive", "other"];
// A no-show means they did not come; everything else means they did.
const OUTCOME_IMPLIES_COMPLETED = new Set(["came", "went_well", "too_expensive", "other"]);
// A visit's outcome moves the pipeline: booking a walk-through is what
// site_visit_scheduled means, and completing one is what site_visit_done means.
const STAGE_FOR_STATUS = { scheduled: "site_visit_scheduled", confirmed: "site_visit_scheduled", completed: "site_visit_done" };
const STAGE_ORDER = ["new", "contacted", "site_visit_scheduled", "site_visit_done", "proposal_sent", "negotiating", "booked", "lost"];

const actorIdOf = (req) => req.venueOwner.memberId || req.venueOwner.venueOwnerId || null;

const resolveOwnVenue = async (req, res) => {
  const venue = await Venue.findOne({ slug: req.params.slug }).select("_id").lean();
  if (!venue) { res.status(404).json({ message: "Venue not found" }); return null; }
  if (String(venue._id) !== String(req.venueOwner.venueId)) { res.status(403).json({ message: "Forbidden" }); return null; }
  return venue;
};

// Resolve a visit AND re-verify the requester may see its parent lead.
async function resolveScopedVisit(req, res) {
  const venue = await resolveOwnVenue(req, res);
  if (!venue) return null;
  if (!mongoose.isValidObjectId(req.params.visitId)) {
    res.status(404).json({ message: "Visit not found" });
    return null;
  }
  const visit = await VenueSiteVisit.findOne({ _id: req.params.visitId, venue: venue._id });
  if (!visit) { res.status(404).json({ message: "Visit not found" }); return null; }
  const lead = await resolveScopedEnquiry(req.venueOwner, req.venueMember, venue._id, visit.enquiryRef);
  if (!lead) { res.status(404).json({ message: "Visit not found" }); return null; }
  return { venue, visit, lead };
}

// Advance the lead's stage to match a visit outcome. Forward-only and
// capability-respecting, exactly like quick-log: a member without
// leads_change_stage still gets the visit recorded, the stage move is skipped
// (never a 403 that loses their work).
async function syncLeadStage(req, lead, status) {
  const target = STAGE_FOR_STATUS[status];
  if (!target) return null;
  if (lead.stage === "booked" || lead.stage === "lost") return null;
  if (STAGE_ORDER.indexOf(target) <= STAGE_ORDER.indexOf(lead.stage)) return null;
  if (!(await hasCapability(req.venueOwner, "leads_change_stage", req.venueMember))) return null;
  lead.activities.push({
    type: "stage_changed",
    description: `Stage advanced to ${target} (site visit ${status})`,
    via: "site_visit",
    actor: actorIdOf(req),
    timestamp: new Date(),
  });
  lead.stage = target;
  return target;
}

// GET /venues/:slug/site-visits?status=&bucket=upcoming|today|past&leadId=
const listOwnSiteVisits = async (req, res) => {
  try {
    const venue = await resolveOwnVenue(req, res);
    if (!venue) return;

    if (req.query.status && !STATUSES.includes(req.query.status)) {
      return res.status(400).json({ message: "Unknown status" });
    }

    // Scope first — the visible lead set bounds what can be listed at all.
    const leadExtra = {};
    if (req.query.leadId) {
      if (!mongoose.isValidObjectId(req.query.leadId)) return res.status(200).json({ visits: [], total: 0, counts: { upcoming: 0, today: 0, past: 0 } });
      leadExtra._id = req.query.leadId;
    }
    const leadFilter = await scopedLeadFilter(req.venueOwner, req.venueMember, venue._id, leadExtra);
    const leadIds = (await VenueEnquiry.find(leadFilter).select("_id").lean()).map((l) => l._id);
    if (leadIds.length === 0) return res.status(200).json({ visits: [], total: 0, counts: { upcoming: 0, today: 0, past: 0 } });

    const filter = { venue: venue._id, enquiryRef: { $in: leadIds } };
    if (req.query.status) filter.status = req.query.status;

    const now = new Date();
    const { start, end } = venueDayBounds(now);
    if (req.query.bucket === "today") filter.scheduledAt = { $gte: start, $lte: end };
    else if (req.query.bucket === "upcoming") { filter.scheduledAt = { $gte: start }; filter.status = filter.status || { $in: ["scheduled", "confirmed"] }; }
    else if (req.query.bucket === "past") filter.scheduledAt = { $lt: start };
    else if (req.query.bucket) return res.status(400).json({ message: "bucket must be upcoming, today or past" });

    const visits = await VenueSiteVisit.find(filter)
      .sort({ scheduledAt: 1 })
      .limit(200)
      .populate("enquiryRef", "coupleName couplePhone stage assignedTo")
      .lean();

    const [upcoming, today, past] = await Promise.all([
      VenueSiteVisit.countDocuments({ venue: venue._id, enquiryRef: { $in: leadIds }, scheduledAt: { $gte: start }, status: { $in: ["scheduled", "confirmed"] } }),
      VenueSiteVisit.countDocuments({ venue: venue._id, enquiryRef: { $in: leadIds }, scheduledAt: { $gte: start, $lte: end } }),
      VenueSiteVisit.countDocuments({ venue: venue._id, enquiryRef: { $in: leadIds }, scheduledAt: { $lt: start } }),
    ]);

    return res.status(200).json({
      visits: visits.map((v) => ({ ...v, bucket: venueDueBucket(v.scheduledAt, now) })),
      total: visits.length,
      counts: { upcoming, today, past },
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// POST /venues/:slug/site-visits  { leadId, scheduledAt, notes? }
// The owner-side creation path the workbench never had.
const createOwnSiteVisit = async (req, res) => {
  try {
    const venue = await resolveOwnVenue(req, res);
    if (!venue) return;
    const body = req.body || {};

    const leadRef = body.leadId || body.enquiryRef;
    if (!leadRef) return res.status(400).json({ message: "leadId is required" });
    if (!mongoose.isValidObjectId(leadRef)) return res.status(404).json({ message: "Lead not found" });
    const lead = await resolveScopedEnquiry(req.venueOwner, req.venueMember, venue._id, leadRef);
    if (!lead) return res.status(404).json({ message: "Lead not found" });

    const when = optDate(body.scheduledAt, "scheduledAt");
    if (!when.ok) return res.status(400).json({ message: when.message });
    if (!when.value) return res.status(400).json({ message: "scheduledAt is required" });
    const notes = optStr(body.notes, "notes", 2000);
    if (!notes.ok) return res.status(400).json({ message: notes.message });
    // Optional at creation: what to have ready before they walk in.
    const prep = optStr(body.prepNote, "prepNote", 2000);
    if (!prep.ok) return res.status(400).json({ message: prep.message });

    const visit = await VenueSiteVisit.create({
      venue: venue._id,
      enquiryRef: lead._id,
      scheduledAt: when.value,
      notes: notes.value,
      prepNote: prep.value,
      status: "scheduled",
      createdByType: "owner",
    });

    const advanced = await syncLeadStage(req, lead, "scheduled");
    lead.activities.push({
      type: "site_visit_scheduled",
      description: `Site visit scheduled for ${venueDateTimeLabel(when.value)}`,
      actor: actorIdOf(req),
      timestamp: new Date(),
    });
    await lead.save();

    return res.status(201).json({ visit, advancedTo: advanced });
  } catch (err) {
    if (err.name === "ValidationError") return res.status(400).json({ message: err.message });
    return res.status(500).json({ message: err.message });
  }
};

// PATCH /venues/:slug/site-visits/:visitId  { status?, scheduledAt?, notes? }
// Status moves, reschedules and note edits. A reschedule is recorded on the
// lead's timeline so "they moved it three times" is visible history.
const updateOwnSiteVisit = async (req, res) => {
  try {
    const owned = await resolveScopedVisit(req, res);
    if (!owned) return;
    const { visit, lead } = owned;
    const body = req.body || {};

    if (
      body.status === undefined && body.scheduledAt === undefined && body.notes === undefined &&
      body.prepNote === undefined && body.outcome === undefined && body.outcomeNote === undefined
    ) {
      return res.status(400).json({ message: "Nothing to update" });
    }
    if (body.outcome !== undefined && body.outcome !== null && !OUTCOMES.includes(body.outcome)) {
      return res.status(400).json({ message: `outcome must be one of ${OUTCOMES.join(", ")}` });
    }
    if (body.status !== undefined && !STATUSES.includes(body.status)) {
      return res.status(400).json({ message: "Unknown status" });
    }
    if (body.notes !== undefined) {
      const n = optStr(body.notes, "notes", 2000);
      if (!n.ok) return res.status(400).json({ message: n.message });
      visit.notes = n.value;
    }

    if (body.prepNote !== undefined) {
      const n = optStr(body.prepNote, "prepNote", 2000);
      if (!n.ok) return res.status(400).json({ message: n.message });
      visit.prepNote = n.value;
    }
    if (body.outcomeNote !== undefined) {
      const n = optStr(body.outcomeNote, "outcomeNote", 2000);
      if (!n.ok) return res.status(400).json({ message: n.message });
      visit.outcomeNote = n.value;
    }
    if (body.outcome !== undefined) {
      visit.outcome = body.outcome || null;
      visit.outcomeAt = body.outcome ? new Date() : undefined;
      if (body.outcome) {
        // Logging an outcome IS closing the visit — asking the owner to also
        // set a status would be two taps for one fact. A no-show is still a
        // finished appointment, so both land on "completed"; which of the two
        // happened is what `outcome` records.
        if (OUTCOME_IMPLIES_COMPLETED.has(body.outcome) || body.outcome === "no_show") {
          visit.status = "completed";
        }
        lead.activities.push({
          type: "site_visit_outcome",
          description: `Site visit outcome: ${body.outcome.replace(/_/g, " ")}`,
          actor: actorIdOf(req),
          timestamp: new Date(),
        });
      }
    }

    if (body.scheduledAt !== undefined) {
      const when = optDate(body.scheduledAt, "scheduledAt");
      if (!when.ok) return res.status(400).json({ message: when.message });
      if (!when.value) return res.status(400).json({ message: "scheduledAt cannot be cleared" });
      if (visit.status === "completed" || visit.status === "cancelled") {
        return res.status(409).json({ message: `Cannot reschedule a ${visit.status} visit` });
      }
      if (visit.scheduledAt && visit.scheduledAt.getTime() !== when.value.getTime()) {
        lead.activities.push({
          type: "site_visit_rescheduled",
          description: `Site visit moved to ${venueDateTimeLabel(when.value)}`,
          actor: actorIdOf(req),
          timestamp: new Date(),
        });
      }
      visit.scheduledAt = when.value;
      // Rescheduling a completed-then-reopened visit puts it back in the queue.
      if (visit.status === "cancelled") visit.status = "scheduled";
    }

    let advanced = null;
    if (body.status !== undefined && body.status !== visit.status) {
      const prev = visit.status;
      visit.status = body.status;
      advanced = await syncLeadStage(req, lead, body.status);
      lead.activities.push({
        type: `site_visit_${body.status}`,
        description:
          body.status === "completed" ? "Site visit completed — they walked the property"
          : body.status === "cancelled" ? "Site visit cancelled / no-show"
          : `Site visit ${prev} → ${body.status}`,
        actor: actorIdOf(req),
        timestamp: new Date(),
      });
    }

    await visit.save();
    await lead.save();
    return res.status(200).json({ visit: visit.toObject(), advancedTo: advanced });
  } catch (err) {
    if (err.name === "ValidationError") return res.status(400).json({ message: err.message });
    return res.status(500).json({ message: err.message });
  }
};

// DELETE /venues/:slug/site-visits/:visitId — leads_delete. Cancelling is the
// everyday action and keeps history; delete exists for rows created in error.
const deleteOwnSiteVisit = async (req, res) => {
  try {
    const owned = await resolveScopedVisit(req, res);
    if (!owned) return;
    const { visit, lead } = owned;
    await visit.deleteOne();
    lead.activities.push({ type: "site_visit_deleted", description: "Site visit deleted", actor: actorIdOf(req), timestamp: new Date() });
    await lead.save();
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { listOwnSiteVisits, createOwnSiteVisit, updateOwnSiteVisit, deleteOwnSiteVisit };
