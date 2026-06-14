const mongoose = require("mongoose");
const Event = require("../models/Event");
const User = require("../models/User");
const Enquiry = require("../models/Enquiry");
const LeadInternalEventService = require("./LeadInternalEventService");

// MB7a — onboarding & money engine. Cross-cutting helpers shared by the finalise
// gate, milestone settings, e-sign, onboard flow, payments, and invoices. The
// CRM lead (Enquiry) and the client planner (Event, keyed by User) are linked
// through the shared phone number — resolveLeadIdForEvent bridges them so
// event-stage actions land on the lead's journey.

const MAX_DRAFTS = 3; // a user may hold at most 3 unfinalized event drafts

// Resolve the CRM lead behind an event (event.user → User → Enquiry by phone).
// Best-effort: returns null when there's no linked lead (journey is advisory).
const resolveLeadIdForEvent = async (event) => {
  try {
    if (!event) return null;
    const user = event.user
      ? await User.findById(event.user, { phone: 1 }).lean()
      : null;
    if (!user || !user.phone) return null;
    const lead = await Enquiry.findOne({ phone: user.phone }, { _id: 1 }).lean();
    return lead ? lead._id : null;
  } catch (e) {
    console.error("[onboarding] resolveLeadIdForEvent failed:", e.message);
    return null;
  }
};

// Record a journey event for an event-stage action, resolving the lead first.
// Fire-safe — never throws into the caller's flow.
const recordEventJourney = async (event, type, actorId, payload = {}) => {
  try {
    const leadId = await resolveLeadIdForEvent(event);
    if (!leadId) return;
    await LeadInternalEventService.record({ leadId, type, actorId: actorId || null, payload });
  } catch (e) {
    console.error("[onboarding] recordEventJourney failed:", e.message);
  }
};

// Count a user's unfinalized event drafts (the draft-cap denominator).
const countDrafts = async (userId) =>
  Event.countDocuments({ user: userId, "status.finalized": false, "status.lost": { $ne: true } });

// Both keys turned: the client finalised AND Wedsy approved → payment unlocks.
const paymentUnlocked = (event) =>
  !!(event && event.status && event.status.finalized && event.status.approved);

module.exports = {
  MAX_DRAFTS,
  resolveLeadIdForEvent,
  recordEventJourney,
  countDrafts,
  paymentUnlocked,
};
