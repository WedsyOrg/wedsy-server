// Slice B2 — THE DEAL SPINE. A derive-on-read station strip for the qualified
// screen: qualified → meeting_set → meeting_held → proposal → agreement →
// onboarded. NOTHING is stored (same philosophy as DiscoveryService — computed
// from existing state objects, so it can't drift):
//   qualified    — Enquiry.qualifiedAt (or the qualified flag for legacy docs)
//   meeting_set  — earliest meet|visit followUp, or stage "meeting_scheduled"
//   meeting_held — a CLOSED CalendarEvent (gmeet|visit) for the lead
//   proposal     — Enquiry.proposalSentAt (POST /enquiry/:_id/proposal-sent)
//   agreement    — Onboarding agreement accepted OR onboarding fee recorded
//   onboarded    — stage "won" OR a Project exists
// current = the first not-done station; it carries a clock (sinceDays/
// sinceLabel) anchored on the previous done station's timestamp.
const CalendarEvent = require("../models/CalendarEvent");
const Onboarding = require("../models/Onboarding");
const Project = require("../models/Project");
const LeadPayment = require("../models/LeadPayment");

const DAY_MS = 24 * 60 * 60 * 1000;
const ts = (v) => {
  if (!v) return null;
  const ms = +new Date(v);
  return Number.isNaN(ms) ? null : ms;
};

// Batched inputs for one lead — one query per collection (no N+1).
const spineInputs = async (leadId) => {
  const [calendarEvents, onboarding, project, firstPayment] = await Promise.all([
    CalendarEvent.find(
      { leadId, type: { $in: ["gmeet", "visit"] } },
      { status: 1, closedAt: 1, start: 1 }
    ).lean(),
    Onboarding.findOne({ leadId }).lean(),
    Project.findOne({ leadId }, { createdAt: 1 }).lean(),
    // Journey v2 (V7): the agreement station's second fact — money moved.
    LeadPayment.findOne({ leadId }, { createdAt: 1 }).sort({ createdAt: 1 }).lean(),
  ]);
  return { calendarEvents, onboarding, project, firstPayment };
};

// PURE — lead doc (plain/lean) + pre-fetched inputs → the six stations.
const computeDealSpine = (lead, { calendarEvents = [], onboarding = null, project = null, firstPayment = null } = {}) => {
  const l = lead || {};

  const qualifiedAt = ts(l.qualifiedAt) || null;
  const qualifiedDone = !!(qualifiedAt || l.qualified === true);

  const meetFus = (l.followUps || []).filter(
    (f) => f && ["meet", "visit"].includes(f.type) && f.scheduledAt
  );
  const earliestMeetAt = meetFus.length ? Math.min(...meetFus.map((f) => ts(f.scheduledAt)).filter(Boolean)) : null;
  const meetingSetDone = earliestMeetAt != null || l.stage === "meeting_scheduled";

  const closedMeets = (calendarEvents || []).filter((e) => e && e.status === "closed");
  const meetingHeldAt = closedMeets.length
    ? Math.min(...closedMeets.map((e) => ts(e.closedAt) || ts(e.start)).filter(Boolean))
    : null;

  const proposalAt = ts(l.proposalSentAt);

  const ob = onboarding || {};
  // Journey v2 (V7): the agreement ritual completes on BOTH facts — the manual
  // "agreement sent" tick AND at least one recorded LeadPayment. The legacy
  // completions (onboarding acceptance / fee / onboarded) remain — old leads'
  // spines never regress.
  const v2AgreementAt =
    l.agreementSentAt && l.agreementSentAt.at && firstPayment
      ? Math.max(ts(l.agreementSentAt.at) || 0, ts(firstPayment.createdAt) || 0) || null
      : null;
  const agreementDone = !!(
    (ob.agreement && ob.agreement.accepted) || ob.onboardingPaymentId || ob.onboardedAt || v2AgreementAt
  );
  const agreementAt =
    ts(ob.agreement && ob.agreement.acceptedAt) || ts(ob.onboardedAt) || v2AgreementAt || null;

  const onboardedDone = l.stage === "won" || !!project;
  const onboardedAt = project ? ts(project.createdAt) : null;

  const stations = [
    { key: "qualified", label: "Qualified", done: qualifiedDone, at: qualifiedAt ? new Date(qualifiedAt) : null },
    { key: "meeting_set", label: "Meeting scheduled", done: meetingSetDone, at: earliestMeetAt ? new Date(earliestMeetAt) : null },
    { key: "meeting_held", label: "Meeting held", done: meetingHeldAt != null, at: meetingHeldAt ? new Date(meetingHeldAt) : null },
    { key: "proposal", label: "Proposal sent", done: proposalAt != null, at: proposalAt ? new Date(proposalAt) : null },
    { key: "agreement", label: "Agreement & fee", done: agreementDone, at: agreementAt ? new Date(agreementAt) : null },
    { key: "onboarded", label: "Converted", done: onboardedDone, at: onboardedAt ? new Date(onboardedAt) : null },
  ].map((s) => ({ ...s, current: false }));

  // current = the first not-done station; its clock anchors on the nearest
  // EARLIER done station's timestamp (falling back to qualifiedAt).
  const idx = stations.findIndex((s) => !s.done);
  if (idx >= 0) {
    stations[idx].current = true;
    let anchor = null;
    for (let i = idx - 1; i >= 0; i--) {
      const at = ts(stations[i].at);
      if (stations[i].done && at) { anchor = at; break; }
    }
    if (anchor == null) anchor = qualifiedAt;
    if (anchor != null) {
      const sinceDays = Math.max(0, Math.floor((Date.now() - anchor) / DAY_MS));
      stations[idx].sinceDays = sinceDays;
      stations[idx].sinceLabel = `${sinceDays}d`;
    }
  }

  return { stations, current: idx >= 0 ? stations[idx].key : null };
};

module.exports = { computeDealSpine, spineInputs };
