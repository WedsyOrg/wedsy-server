/**
 * utils/venueFollowUp.js — the ONE place the follow-ups collection and the
 * lead's next-touch mirror are kept in agreement.
 *
 * VenueFollowUp is the source of truth. VenueEnquiry.followUpDate/.followUpNote
 * are a denormalised cache of the NEXT OPEN follow-up so every pre-existing
 * consumer (CRM dashboard, owner dashboard, portfolio, WhatsApp digest, list
 * rows, heat colour, the workbench's amber "set the next touch" panel) keeps
 * working with no changes. Nothing else may write those two fields — every
 * write path funnels through syncLeadNextFollowUp().
 */
const mongoose = require("mongoose");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueFollowUp = require("../models/VenueFollowUp");
const { scopedLeadFilter } = require("./venueLeadScope");

const TERMINAL_STAGES = ["booked", "lost"];

/**
 * Recompute lead.followUpDate/.followUpNote from the lead's open follow-ups.
 * The "next" one is the earliest-due OPEN row; when none exist the mirror is
 * cleared, which is what makes the lead show up in the "no next step" alert.
 * Returns the next follow-up doc (or null).
 */
async function syncLeadNextFollowUp(leadId) {
  const next = await VenueFollowUp.findOne({ lead: leadId, status: "open" })
    .sort({ dueAt: 1, createdAt: 1 })
    .select("dueAt note")
    .lean();
  await VenueEnquiry.updateOne(
    { _id: leadId },
    next
      ? { $set: { followUpDate: next.dueAt, followUpNote: next.note || "" } }
      : { $set: { followUpDate: null, followUpNote: "" } }
  );
  return next || null;
}

/**
 * Upsert the lead's NEXT OPEN follow-up from a legacy-shaped write
 * ({ followUpDate, followUpNote }). This is what keeps quick-log, the snooze
 * button and PATCH /enquiries working unchanged while the data lives in the
 * new collection: setting a date edits the existing open row if there is one,
 * otherwise creates one; clearing the date cancels the open row.
 *
 * `dueAt === null` means "clear the next touch" (the Log & clear action).
 * `dueAt === undefined` means "not sent" — note-only edits land on the open row.
 */
async function applyLegacyFollowUpWrite({ lead, venueId, dueAt, note, actorId, type = "call" }) {
  const existing = await VenueFollowUp.findOne({ lead: lead._id, status: "open" }).sort({ dueAt: 1, createdAt: 1 });

  if (dueAt === null) {
    if (existing) {
      // Clearing the touch closes it out as done — the rep just did it. The
      // note becomes the outcome so the history says what the touch was for.
      existing.status = "done";
      existing.completedAt = new Date();
      existing.completedBy = actorId || null;
      if (!existing.outcome) existing.outcome = note || existing.note || "";
      await existing.save();
    }
    await syncLeadNextFollowUp(lead._id);
    return existing || null;
  }

  if (dueAt === undefined) {
    if (note !== undefined && existing) {
      existing.note = note;
      await existing.save();
      await syncLeadNextFollowUp(lead._id);
    }
    return existing || null;
  }

  if (existing) {
    if (existing.dueAt && new Date(existing.dueAt).getTime() !== new Date(dueAt).getTime()) {
      existing.reschedules.push({ from: existing.dueAt, to: dueAt, at: new Date(), by: actorId || null });
    }
    existing.dueAt = dueAt;
    if (note !== undefined) existing.note = note;
    await existing.save();
    await syncLeadNextFollowUp(lead._id);
    return existing;
  }

  const created = await VenueFollowUp.create({
    venue: venueId,
    lead: lead._id,
    type,
    dueAt,
    note: note || "",
    // A follow-up defaults to the lead's owner: whoever has the lead owes the
    // next touch. Falls back to the acting member for an unassigned lead.
    assignedTo: lead.assignedTo || (mongoose.isValidObjectId(actorId) ? actorId : null),
    createdBy: actorId || null,
  });
  await syncLeadNextFollowUp(lead._id);
  return created;
}

/**
 * The set of lead ids this requester may see, as a filter fragment for
 * follow-up queries. Follow-ups are LEAD-DERIVED data, so visibility is the
 * lead's visibility (invariant #5) — never the follow-up's own assignedTo,
 * which would leak a lead a member cannot open.
 * Soft-deleted leads are excluded because scopedLeadFilter excludes them.
 */
async function scopedFollowUpLeadIds(venueOwner, venueMember, venueId, extra = {}) {
  const leadFilter = await scopedLeadFilter(venueOwner, venueMember, venueId, extra);
  const leads = await VenueEnquiry.find(leadFilter).select("_id").lean();
  return leads.map((l) => l._id);
}

module.exports = {
  TERMINAL_STAGES,
  syncLeadNextFollowUp,
  applyLegacyFollowUpWrite,
  scopedFollowUpLeadIds,
};
