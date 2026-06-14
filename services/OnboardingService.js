const mongoose = require("mongoose");
const Event = require("../models/Event");
const User = require("../models/User");
const Enquiry = require("../models/Enquiry");
const Config = require("../models/Config");
const LeadInternalEventService = require("./LeadInternalEventService");

// ── Milestone settings (Slice 2) ────────────────────────────────────────────
// Stored via the existing /config pattern under code "OnboardingMilestones".
// ALL AMOUNTS ARE IN RUPEES here and across the onboarding layer — we convert to
// paise only at the Payment/Razorpay boundary (×100), fixing the paise/rupee
// ambiguity the audit flagged.
const MILESTONE_CODE = "OnboardingMilestones";
const MILESTONE_DEFAULTS = {
  onboardingFee: 25000, // rupees — token to start onboarding; counts toward the advance
  advancePercent: 25, // % of total due as advance
  balanceDaysBeforeEvent: 14, // balance falls due this many days before the event
};

const getMilestoneConfig = async () => {
  try {
    const row = await Config.findOne({ code: MILESTONE_CODE }).lean();
    const d = (row && row.data) || {};
    return {
      onboardingFee: Number.isFinite(d.onboardingFee) ? d.onboardingFee : MILESTONE_DEFAULTS.onboardingFee,
      advancePercent: Number.isFinite(d.advancePercent) ? d.advancePercent : MILESTONE_DEFAULTS.advancePercent,
      balanceDaysBeforeEvent: Number.isFinite(d.balanceDaysBeforeEvent) ? d.balanceDaysBeforeEvent : MILESTONE_DEFAULTS.balanceDaysBeforeEvent,
    };
  } catch (_) {
    return { ...MILESTONE_DEFAULTS };
  }
};

// Compute the three milestones for a total (rupees). The onboarding fee counts
// TOWARD the advance; the balance is the remainder, due before the event; the
// full amount is due before the event day.
//   advance  = round(advancePercent% of total)
//   onboardingFee (capped at advance) is the first slice of the advance
//   advanceRemaining = advance − onboardingFee  (the rest of the 25%)
//   balance  = total − advance
const computeMilestones = (totalRupees, cfg) => {
  const total = Math.max(0, Math.round(Number(totalRupees) || 0));
  const advance = Math.round((total * cfg.advancePercent) / 100);
  const onboardingFee = Math.min(cfg.onboardingFee, advance || cfg.onboardingFee);
  const advanceRemaining = Math.max(0, advance - onboardingFee);
  const balance = Math.max(0, total - advance);
  return {
    currency: "INR",
    unit: "rupees",
    total,
    advancePercent: cfg.advancePercent,
    advance, // 25% of total
    onboardingFee, // counts toward the advance
    advanceRemaining, // advance left after the onboarding fee
    balance, // remainder, due before the event
    balanceDaysBeforeEvent: cfg.balanceDaysBeforeEvent,
  };
};

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
  MILESTONE_CODE,
  MILESTONE_DEFAULTS,
  getMilestoneConfig,
  computeMilestones,
  resolveLeadIdForEvent,
  recordEventJourney,
  countDrafts,
  paymentUnlocked,
};
