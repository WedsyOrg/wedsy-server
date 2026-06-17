// SEQ-1 / SEQ-3c — the discovery brief's completeness, COMPUTED on read (never
// stored, so it can't drift).
//
// SEQ-3c CORRECTS the gate. A lead's discovery is complete when just two things
// are captured:
//   1. a NAME — the enquiry name, or the groom/bride name; and
//   2. a discovery EVENT DATE the intern filled — an exact date AND/OR a
//      part-of-day (morning/afternoon/evening). Either alone is enough.
//
// City, guests/pax, services and budget are OPTIONAL added info — they no longer
// gate (this replaces the old eventDate AND city AND guests AND services rule).
//
// CRITICAL EXCLUSION: the event date for the gate is ONLY the intern-filled
// discovery field (qualificationData.eventDate / eventDatePart). The ad-form
// month BAND (adFormAnswers.eventMonth / "between_3-6_months" / "beyond_6_months"
// …) and Kiara's coarse auto-captured band are a DIFFERENT, fuzzy field and are
// deliberately ignored here — a band must never satisfy the gate.

const present = (v) => {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.length > 0;
  return String(v).trim().length > 0;
};

// Compute the discovery snapshot for a lead doc (a plain object or a lean doc).
const computeDiscovery = (lead) => {
  const qd = (lead && lead.qualificationData) || {};

  // Name — the enquiry name, or a captured groom/bride name.
  const hasName = present(lead && lead.name) || present(qd.groomName) || present(qd.brideName);

  // Event date — ONLY the intern-filled discovery date: an exact date and/or a
  // part-of-day. NOT the ad-form/Kiara month band (see the exclusion above).
  const hasEventDate = present(qd.eventDate) || present(qd.eventDatePart);

  const missing = [];
  if (!hasName) missing.push("name");
  if (!hasEventDate) missing.push("eventDate");
  const complete = missing.length === 0;

  return {
    discoveryComplete: complete,
    discovery: { complete, missing, hasName, hasEventDate },
  };
};

module.exports = { computeDiscovery };
