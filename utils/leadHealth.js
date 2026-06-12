// Lead Health: derived Cold/Warm/Hot 0-100 — computed on read, NEVER stored.
// Weights mirror the approved cockpit design's score():
//   qualified base 20, event captured +25, venue status +15, email (or explicit
//   not-willing) +20, future follow-up locked +20. Unqualified leads sit at 15/Cold.
const computeLeadHealth = (enquiry, events = []) => {
  const q = (enquiry && enquiry.qualificationData) || {};

  if (!enquiry || !enquiry.qualified) {
    return {
      score: 15,
      label: "Cold",
      have: [],
      missing: ["qualified call"],
    };
  }

  let score = 20;
  const have = [];
  const missing = [];

  const hasEvent = (events || []).some(
    (e) => Array.isArray(e.eventDays) && e.eventDays.length > 0
  );
  if (hasEvent) {
    score += 25;
    have.push("event");
  } else {
    missing.push("event details");
  }

  if (q.venueStatus) {
    score += 15;
    have.push("venue");
  } else {
    missing.push("venue");
  }

  if (q.email || q.emailNotWilling) {
    score += 20;
    if (q.email) have.push("email");
  } else {
    missing.push("email");
  }

  const now = new Date();
  const hasFutureFollowUp = (enquiry.followUps || []).some(
    (f) => f.scheduledAt && new Date(f.scheduledAt) > now
  );
  if (hasFutureFollowUp) {
    score += 20;
    have.push("next step");
  } else {
    missing.push("a booked next step");
  }

  if (score > 100) score = 100;
  const label = score >= 75 ? "Hot" : score >= 45 ? "Warm" : "Cold";
  return { score, label, have, missing };
};

module.exports = { computeLeadHealth };
