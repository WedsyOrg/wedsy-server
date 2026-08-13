/**
 * controllers/venueFollowUp.js — the follow-ups module.
 *
 * Follow-ups are LEAD-DERIVED: every read and write resolves the parent lead
 * through utils/venueLeadScope first, so a member without leads_view_all can
 * neither see nor touch a follow-up on someone else's lead (404, never 403 —
 * existence is not leaked). Soft-deleted leads take their follow-ups with them.
 *
 * VenueEnquiry.followUpDate/.followUpNote stay in sync as the "next open
 * follow-up" mirror via utils/venueFollowUp — see that file for why.
 */
const mongoose = require("mongoose");
const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueFollowUp = require("../models/VenueFollowUp");
const { hasCapability } = require("../utils/venueRbac");
const { resolveActorMemberId } = require("../utils/venueOwnerMember");
const { validateAssignable } = require("../utils/venueLeadAssign");
const { resolveScopedEnquiry, scopedLeadFilter } = require("../utils/venueLeadScope");
const { syncLeadNextFollowUp, scopedFollowUpLeadIds } = require("../utils/venueFollowUp");
const { venueDayBounds, addVenueDays, venueDueBucket, venueDateLabel } = require("../utils/venueTime");
const { optDate, optStr, cleanStr, MAXLEN } = require("../utils/venueInput");

const TYPE_ENUM = ["call", "whatsapp", "email", "site_visit", "meeting", "other"];
const PRIORITY_ENUM = ["low", "normal", "high"];
const STATUS_ENUM = ["open", "done", "cancelled"];
const STAGE_ENUM = ["new", "contacted", "site_visit_scheduled", "site_visit_done", "proposal_sent", "negotiating", "booked", "lost"];
const MAX_REMINDER_MIN = 60 * 24 * 14; // two weeks

const actorIdOf = (req) => req.venueOwner.memberId || req.venueOwner.venueOwnerId || null;

async function resolveOwnedVenue(req, res) {
  const venue = await Venue.findOne({ slug: req.params.slug }).select("_id name slug").lean();
  if (!venue) { res.status(404).json({ message: "Venue not found" }); return null; }
  if (String(venue._id) !== String(req.venueOwner.venueId)) { res.status(403).json({ message: "Forbidden" }); return null; }
  return venue;
}

// Resolve a follow-up AND re-verify the requester may see its parent lead.
// Returns { venue, followUp, lead } or sends the error response.
async function resolveScopedFollowUp(req, res) {
  const venue = await resolveOwnedVenue(req, res);
  if (!venue) return null;
  if (!mongoose.isValidObjectId(req.params.followUpId)) {
    res.status(404).json({ message: "Follow-up not found" });
    return null;
  }
  const followUp = await VenueFollowUp.findOne({ _id: req.params.followUpId, venue: venue._id });
  if (!followUp) { res.status(404).json({ message: "Follow-up not found" }); return null; }
  // The scope boundary lives on the LEAD, not the follow-up.
  const lead = await resolveScopedEnquiry(req.venueOwner, req.venueMember, venue._id, followUp.lead);
  if (!lead) { res.status(404).json({ message: "Follow-up not found" }); return null; }
  return { venue, followUp, lead };
}

// Assigning a follow-up to someone else reuses tasks_assign_others: a follow-up
// is a work item pushed onto a colleague's day, exactly like a task. Reusing
// the existing capability avoids inventing one that no role bundle grants yet.
async function resolveFollowUpAssignee(req, venueId, assignedTo, { fallback } = {}) {
  if (assignedTo === undefined) return { ok: true, id: fallback };
  if (assignedTo == null || String(assignedTo).trim() === "") return { ok: true, id: null };
  // The owner's member row for owner tokens — a raw memberId is undefined there,
  // so an owner assigning a follow-up to themselves would be charged for
  // tasks_assign_others.
  const me = await resolveActorMemberId(req);
  if (!me || String(assignedTo) !== String(me)) {
    if (!(await hasCapability(req.venueOwner, "tasks_assign_others", req.venueMember))) {
      return { ok: false, status: 403, message: "You don't have permission to assign follow-ups to others" };
    }
  }
  const v = await validateAssignable(venueId, assignedTo);
  if (!v.ok) return { ok: false, status: 422, message: v.message };
  return { ok: true, id: v.id };
}

// Shape a row for the list: everything a rep needs to act without opening it.
function shapeFollowUp(f, leadById, now) {
  const lead = leadById.get(String(f.lead)) || null;
  return {
    _id: f._id,
    type: f.type,
    dueAt: f.dueAt,
    priority: f.priority,
    note: f.note,
    status: f.status,
    outcome: f.outcome,
    completedAt: f.completedAt,
    cancelledAt: f.cancelledAt,
    cancelReason: f.cancelReason,
    rescheduleCount: (f.reschedules || []).length,
    reminderMinutesBefore: f.reminderMinutesBefore,
    createdAt: f.createdAt,
    assignedTo: f.assignedTo || null,
    // Bucket is computed server-side off the venue's IST day so the list, the
    // dashboard counts and the drill-down can never disagree.
    bucket: f.status === "open" ? venueDueBucket(f.dueAt, now) : null,
    lead: lead
      ? {
          _id: lead._id,
          name: lead.coupleName || lead.name || "Lead",
          phone: lead.couplePhone || lead.phone || "",
          stage: lead.stage,
          eventDate: lead.eventDate,
          assignedTo: lead.assignedTo || null,
        }
      : null,
  };
}

// GET /venues/:slug/follow-ups
// ?bucket=overdue|today|tomorrow|this_week|later &status= &assignee=me|<id>|unassigned
// &stage= &type= &priority= &leadId= &includeClosed=1
const listFollowUps = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;

    const { bucket, status, assignee, stage, type, priority, leadId, includeClosed } = req.query || {};
    if (status !== undefined && status !== "" && !STATUS_ENUM.includes(status)) {
      return res.status(400).json({ message: `status must be one of ${STATUS_ENUM.join(", ")}` });
    }
    if (type !== undefined && type !== "" && !TYPE_ENUM.includes(type)) {
      return res.status(400).json({ message: `type must be one of ${TYPE_ENUM.join(", ")}` });
    }
    if (priority !== undefined && priority !== "" && !PRIORITY_ENUM.includes(priority)) {
      return res.status(400).json({ message: `priority must be one of ${PRIORITY_ENUM.join(", ")}` });
    }
    if (stage !== undefined && stage !== "" && !STAGE_ENUM.includes(stage)) {
      return res.status(400).json({ message: `stage must be one of ${STAGE_ENUM.join(", ")}` });
    }

    // Scope first: the visible lead set bounds everything below.
    const leadExtra = {};
    if (stage) leadExtra.stage = stage;
    if (leadId) {
      if (!mongoose.isValidObjectId(leadId)) return res.status(200).json({ followUps: [], total: 0, counts: emptyCounts(), scoped: true });
      leadExtra._id = leadId;
    }
    const leadFilter = await scopedLeadFilter(req.venueOwner, req.venueMember, venue._id, leadExtra);
    const leads = await VenueEnquiry.find(leadFilter)
      .select("coupleName name couplePhone phone stage eventDate assignedTo")
      .lean();
    const leadById = new Map(leads.map((l) => [String(l._id), l]));
    if (leads.length === 0) {
      return res.status(200).json({ followUps: [], total: 0, counts: emptyCounts(), scoped: true });
    }

    const q = { venue: venue._id, lead: { $in: leads.map((l) => l._id) } };
    if (status) q.status = status;
    else if (!includeClosed) q.status = "open";
    if (type) q.type = type;
    if (priority) q.priority = priority;
    // "me" resolves to the OWNER'S MEMBER ROW for an owner token. It used to
    // fall through to null, i.e. an owner asking for their own follow-ups got
    // the UNASSIGNED ones — the old "owner == unassigned" convention. Unassigned
    // follow-ups are still reachable, under the name that actually describes
    // them: assignee=unassigned.
    if (assignee === "me") q.assignedTo = (await resolveActorMemberId(req)) || null;
    else if (assignee === "unassigned") q.assignedTo = null;
    else if (assignee) {
      if (!mongoose.isValidObjectId(assignee)) return res.status(400).json({ message: "assignee must be a member id, 'me' or 'unassigned'" });
      q.assignedTo = assignee;
    }

    const now = new Date();
    if (bucket) {
      const { start, end } = venueDayBounds(now);
      if (bucket === "overdue") q.dueAt = { $lt: start };
      else if (bucket === "today") q.dueAt = { $gte: start, $lte: end };
      else if (bucket === "tomorrow") q.dueAt = { $gte: addVenueDays(now, 1), $lt: addVenueDays(now, 2) };
      else if (bucket === "this_week") q.dueAt = { $gte: addVenueDays(now, 2), $lt: addVenueDays(now, 8) };
      else if (bucket === "later") q.dueAt = { $gte: addVenueDays(now, 8) };
      else return res.status(400).json({ message: "bucket must be overdue, today, tomorrow, this_week or later" });
    }

    const rows = await VenueFollowUp.find(q)
      .sort({ dueAt: 1, createdAt: 1 })
      .limit(500)
      .populate("assignedTo", "name")
      .lean();

    // Bucket counts come from the SAME scoped lead set, so the sidebar totals
    // and the rows behind them are guaranteed to agree (invariant #7).
    const counts = await bucketCounts(venue._id, leads.map((l) => l._id), q, now);

    return res.status(200).json({
      followUps: rows.map((f) => shapeFollowUp(f, leadById, now)),
      total: rows.length,
      counts,
      scoped: !(await hasCapability(req.venueOwner, "leads_view_all", req.venueMember)),
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

const emptyCounts = () => ({ overdue: 0, today: 0, tomorrow: 0, this_week: 0, later: 0, open: 0, done: 0, cancelled: 0 });

// Counts for every bucket + closed states, over the scoped lead set. The
// caller's non-date filters (type/priority/assignee) are honoured so the
// sidebar reflects what the user is actually looking at.
async function bucketCounts(venueId, leadIds, q, now) {
  const base = { venue: venueId, lead: { $in: leadIds } };
  for (const k of ["type", "priority", "assignedTo"]) if (q[k] !== undefined) base[k] = q[k];
  const { start, end } = venueDayBounds(now);
  const d1 = addVenueDays(now, 1), d2 = addVenueDays(now, 2), d8 = addVenueDays(now, 8);
  const [overdue, today, tomorrow, thisWeek, later, open, done, cancelled] = await Promise.all([
    VenueFollowUp.countDocuments({ ...base, status: "open", dueAt: { $lt: start } }),
    VenueFollowUp.countDocuments({ ...base, status: "open", dueAt: { $gte: start, $lte: end } }),
    VenueFollowUp.countDocuments({ ...base, status: "open", dueAt: { $gte: d1, $lt: d2 } }),
    VenueFollowUp.countDocuments({ ...base, status: "open", dueAt: { $gte: d2, $lt: d8 } }),
    VenueFollowUp.countDocuments({ ...base, status: "open", dueAt: { $gte: d8 } }),
    VenueFollowUp.countDocuments({ ...base, status: "open" }),
    VenueFollowUp.countDocuments({ ...base, status: "done" }),
    VenueFollowUp.countDocuments({ ...base, status: "cancelled" }),
  ]);
  return { overdue, today, tomorrow, this_week: thisWeek, later, open, done, cancelled };
}

// Validate the shared write payload. Returns { ok, value } or { ok:false, ... }.
function validateFollowUpBody(body, { requireDue }) {
  const out = {};
  if (body.type !== undefined) {
    if (!TYPE_ENUM.includes(body.type)) return { ok: false, status: 400, message: `type must be one of ${TYPE_ENUM.join(", ")}` };
    out.type = body.type;
  }
  if (body.priority !== undefined) {
    if (!PRIORITY_ENUM.includes(body.priority)) return { ok: false, status: 400, message: `priority must be one of ${PRIORITY_ENUM.join(", ")}` };
    out.priority = body.priority;
  }
  if (body.dueAt !== undefined || requireDue) {
    const d = optDate(body.dueAt, "dueAt");
    if (!d.ok) return { ok: false, status: 400, message: d.message };
    if (requireDue && !d.value) return { ok: false, status: 400, message: "dueAt is required" };
    if (d.value) out.dueAt = d.value;
  }
  if (body.note !== undefined) {
    const n = optStr(body.note, "note", MAXLEN.text);
    if (!n.ok) return { ok: false, status: 400, message: n.message };
    out.note = n.value;
  }
  if (body.reminderMinutesBefore !== undefined) {
    if (body.reminderMinutesBefore === null || body.reminderMinutesBefore === "") out.reminderMinutesBefore = null;
    else {
      const n = Number(body.reminderMinutesBefore);
      if (!Number.isInteger(n) || n < 0 || n > MAX_REMINDER_MIN) {
        return { ok: false, status: 400, message: `reminderMinutesBefore must be a whole number of minutes between 0 and ${MAX_REMINDER_MIN}` };
      }
      out.reminderMinutesBefore = n;
    }
  }
  return { ok: true, value: out };
}

// POST /venues/:slug/follow-ups  { leadId, dueAt, type?, priority?, note?, assignedTo?, reminderMinutesBefore? }
const createFollowUp = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const body = req.body || {};

    const leadRef = body.leadId || body.lead;
    if (!leadRef) return res.status(400).json({ message: "leadId is required — a follow-up always belongs to a lead" });
    if (!mongoose.isValidObjectId(leadRef)) return res.status(404).json({ message: "Lead not found" });
    const lead = await resolveScopedEnquiry(req.venueOwner, req.venueMember, venue._id, leadRef);
    if (!lead) return res.status(404).json({ message: "Lead not found" });

    const v = validateFollowUpBody(body, { requireDue: true });
    if (!v.ok) return res.status(v.status).json({ message: v.message });

    // Default owner: the lead's assignee (whoever owns the lead owes the next
    // touch), falling back to the acting member — which now resolves for an
    // owner too. Leaving it undefined here would create the owner's own
    // follow-ups as unassigned, and assignee=me no longer means unassigned.
    const fallback = lead.assignedTo || (await resolveActorMemberId(req)) || null;
    const assignee = await resolveFollowUpAssignee(req, venue._id, body.assignedTo, { fallback });
    if (!assignee.ok) return res.status(assignee.status).json({ message: assignee.message });

    const followUp = await VenueFollowUp.create({
      venue: venue._id,
      lead: lead._id,
      ...v.value,
      assignedTo: assignee.id || null,
      createdBy: actorIdOf(req),
    });

    lead.activities.push({
      type: "followup_scheduled",
      description: `Follow-up scheduled (${followUp.type}) for ${venueDateLabel(followUp.dueAt)}`,
      actor: actorIdOf(req),
      timestamp: new Date(),
    });
    await lead.save();
    await syncLeadNextFollowUp(lead._id);

    return res.status(201).json({ followUp });
  } catch (err) {
    if (err.name === "ValidationError") return res.status(400).json({ message: err.message });
    return res.status(500).json({ message: err.message });
  }
};

// GET /venues/:slug/follow-ups/:followUpId — detail view (with history).
const getFollowUp = async (req, res) => {
  try {
    const owned = await resolveScopedFollowUp(req, res);
    if (!owned) return;
    const { followUp, lead } = owned;
    const populated = await VenueFollowUp.findById(followUp._id).populate("assignedTo", "name").lean();
    return res.status(200).json({
      followUp: {
        ...populated,
        lead: {
          _id: lead._id,
          name: lead.coupleName || lead.name || "Lead",
          phone: lead.couplePhone || lead.phone || "",
          stage: lead.stage,
          eventDate: lead.eventDate,
        },
      },
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// PATCH /venues/:slug/follow-ups/:followUpId — reschedule / retarget / re-own.
const updateFollowUp = async (req, res) => {
  try {
    const owned = await resolveScopedFollowUp(req, res);
    if (!owned) return;
    const { venue, followUp, lead } = owned;
    const body = req.body || {};

    if (followUp.status !== "open" && (body.dueAt !== undefined || body.assignedTo !== undefined)) {
      return res.status(409).json({ message: `Cannot reschedule or reassign a ${followUp.status} follow-up — reopen it first` });
    }

    const v = validateFollowUpBody(body, { requireDue: false });
    if (!v.ok) return res.status(v.status).json({ message: v.message });

    // Moving a follow-up to a different lead must re-check scope on the TARGET.
    if (body.leadId !== undefined && String(body.leadId) !== String(followUp.lead)) {
      if (!mongoose.isValidObjectId(body.leadId)) return res.status(404).json({ message: "Lead not found" });
      const target = await resolveScopedEnquiry(req.venueOwner, req.venueMember, venue._id, body.leadId, { select: "_id", lean: true });
      if (!target) return res.status(404).json({ message: "Lead not found" });
      followUp.lead = target._id;
    }

    if (body.assignedTo !== undefined) {
      const assignee = await resolveFollowUpAssignee(req, venue._id, body.assignedTo, { fallback: followUp.assignedTo });
      if (!assignee.ok) return res.status(assignee.status).json({ message: assignee.message });
      followUp.assignedTo = assignee.id || null;
    }

    if (v.value.dueAt && followUp.dueAt && new Date(v.value.dueAt).getTime() !== new Date(followUp.dueAt).getTime()) {
      followUp.reschedules.push({ from: followUp.dueAt, to: v.value.dueAt, at: new Date(), by: actorIdOf(req) });
      lead.activities.push({
        type: "followup_rescheduled",
        description: `Follow-up moved to ${venueDateLabel(v.value.dueAt)}`,
        actor: actorIdOf(req),
        timestamp: new Date(),
      });
      await lead.save();
    }
    for (const [k, val] of Object.entries(v.value)) followUp[k] = val;
    await followUp.save();

    // Both the old and the new lead need their mirror recomputed.
    await syncLeadNextFollowUp(lead._id);
    if (String(followUp.lead) !== String(lead._id)) await syncLeadNextFollowUp(followUp.lead);

    return res.status(200).json({ followUp });
  } catch (err) {
    if (err.name === "ValidationError") return res.status(400).json({ message: err.message });
    return res.status(500).json({ message: err.message });
  }
};

// POST /venues/:slug/follow-ups/:followUpId/complete
// { outcome?, next?: { dueAt, type?, note?, priority?, assignedTo? } }
// Completing retains the row (history), stamps who/when, writes a lead activity
// entry, and OPTIONALLY chains the next follow-up in the same call so the
// workflow never ends abruptly.
const completeFollowUp = async (req, res) => {
  try {
    const owned = await resolveScopedFollowUp(req, res);
    if (!owned) return;
    const { venue, followUp, lead } = owned;

    // Idempotence / double-click guard: completing a closed row is a no-op 409
    // rather than a second timeline entry.
    if (followUp.status !== "open") {
      return res.status(409).json({ message: `This follow-up is already ${followUp.status}` });
    }

    const body = req.body || {};
    const outcomeV = optStr(body.outcome, "outcome", MAXLEN.text);
    if (!outcomeV.ok) return res.status(400).json({ message: outcomeV.message });

    followUp.status = "done";
    followUp.completedAt = new Date();
    followUp.completedBy = actorIdOf(req);
    followUp.outcome = outcomeV.value;
    await followUp.save();

    lead.activities.push({
      type: "followup_done",
      description: outcomeV.value
        ? `Follow-up (${followUp.type}) completed — ${outcomeV.value}`
        : `Follow-up (${followUp.type}) completed`,
      actor: actorIdOf(req),
      timestamp: new Date(),
    });

    // Chain the next touch in the same request when the caller supplies one.
    let next = null;
    if (body.next && body.next.dueAt) {
      const nv = validateFollowUpBody(body.next, { requireDue: true });
      if (!nv.ok) return res.status(nv.status).json({ message: nv.message });
      const assignee = await resolveFollowUpAssignee(req, venue._id, body.next.assignedTo, {
        fallback: followUp.assignedTo || lead.assignedTo || (await resolveActorMemberId(req)) || null,
      });
      if (!assignee.ok) return res.status(assignee.status).json({ message: assignee.message });
      next = await VenueFollowUp.create({
        venue: venue._id,
        lead: lead._id,
        ...nv.value,
        assignedTo: assignee.id || null,
        createdBy: actorIdOf(req),
      });
      lead.activities.push({
        type: "followup_scheduled",
        description: `Next follow-up scheduled (${next.type}) for ${venueDateLabel(next.dueAt)}`,
        actor: actorIdOf(req),
        timestamp: new Date(),
      });
    }

    await lead.save();
    const mirror = await syncLeadNextFollowUp(lead._id);

    return res.status(200).json({
      followUp,
      next,
      // Tells the UI whether the lead is now without a next step, so it can
      // prompt instead of leaving a dead end.
      leadHasNextStep: Boolean(mirror),
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// POST /venues/:slug/follow-ups/:followUpId/cancel  { reason? }
const cancelFollowUp = async (req, res) => {
  try {
    const owned = await resolveScopedFollowUp(req, res);
    if (!owned) return;
    const { followUp, lead } = owned;
    if (followUp.status !== "open") {
      return res.status(409).json({ message: `This follow-up is already ${followUp.status}` });
    }
    const reasonV = optStr((req.body || {}).reason, "reason", MAXLEN.label);
    if (!reasonV.ok) return res.status(400).json({ message: reasonV.message });

    followUp.status = "cancelled";
    followUp.cancelledAt = new Date();
    followUp.cancelledBy = actorIdOf(req);
    followUp.cancelReason = reasonV.value;
    await followUp.save();

    lead.activities.push({
      type: "followup_cancelled",
      description: reasonV.value ? `Follow-up cancelled — ${reasonV.value}` : "Follow-up cancelled",
      actor: actorIdOf(req),
      timestamp: new Date(),
    });
    await lead.save();
    const mirror = await syncLeadNextFollowUp(lead._id);
    return res.status(200).json({ followUp, leadHasNextStep: Boolean(mirror) });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// POST /venues/:slug/follow-ups/:followUpId/reopen — a closed follow-up returns
// to the queue. Its completion/cancellation stamps are cleared but the
// reschedule history and outcome text survive as history.
const reopenFollowUp = async (req, res) => {
  try {
    const owned = await resolveScopedFollowUp(req, res);
    if (!owned) return;
    const { followUp, lead } = owned;
    if (followUp.status === "open") return res.status(409).json({ message: "This follow-up is already open" });

    followUp.status = "open";
    followUp.completedAt = undefined;
    followUp.completedBy = undefined;
    followUp.cancelledAt = undefined;
    followUp.cancelledBy = undefined;
    await followUp.save();

    lead.activities.push({ type: "followup_reopened", description: "Follow-up reopened", actor: actorIdOf(req), timestamp: new Date() });
    await lead.save();
    await syncLeadNextFollowUp(lead._id);
    return res.status(200).json({ followUp });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// DELETE /venues/:slug/follow-ups/:followUpId — hard delete, gated on
// leads_delete. Cancel is the everyday action (it keeps history); delete exists
// only to remove a row created in error, so it is owner-shaped by default.
const deleteFollowUp = async (req, res) => {
  try {
    const owned = await resolveScopedFollowUp(req, res);
    if (!owned) return;
    const { followUp, lead } = owned;
    await followUp.deleteOne();
    lead.activities.push({ type: "followup_deleted", description: "Follow-up deleted", actor: actorIdOf(req), timestamp: new Date() });
    await lead.save();
    await syncLeadNextFollowUp(lead._id);
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = {
  listFollowUps,
  createFollowUp,
  getFollowUp,
  updateFollowUp,
  completeFollowUp,
  cancelFollowUp,
  reopenFollowUp,
  deleteFollowUp,
  // exported for the dashboard/digest so counts derive from one implementation
  bucketCounts,
  scopedFollowUpLeadIds,
};
