// Lead-schema foundation — the discovery brief's completeness, COMPUTED on read
// (never stored, so it can't drift).
//
// THE GATE is exactly two things, BOTH required:
//   1. a canonical EVENT DATE — qualificationData.eventDate (the earliest dated
//      EventBuilder day, synced server-side); AND
//   2. SERVICES — qualificationData.servicesRequired non-empty.
//
// This REPLACES the prior name+date rule. eventDatePart is RETIRED from the gate
// (part-of-day now lives per-function in the Event store, not as a gate field).
// Name, city, zones, guests/pax and budget are OPTIONAL added info — they do not
// gate.
//
// CRITICAL EXCLUSION: the gate's date is ONLY the canonical qualificationData.
// eventDate. The ad-form month BAND (adFormAnswers.eventMonth / "between_3-6_
// months" …) and Kiara's coarse auto-captured band are a DIFFERENT, fuzzy field
// and are deliberately ignored — a band must never satisfy the gate.

const present = (v) => {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.length > 0;
  return String(v).trim().length > 0;
};

// Has ANYTHING been meaningfully captured in the qualification draft?
// Booleans count only when true (schema defaults like whatsappSameNumber:false
// must never read as "captured"); mongoose internals (_id etc.) are skipped.
const anyCaptured = (qd) =>
  Object.entries(qd).some(([k, v]) => {
    if (k.startsWith("_")) return false;
    if (typeof v === "boolean") return v === true;
    return present(v);
  });

// Compute the discovery snapshot for a lead doc (a plain object or a lean doc).
const computeDiscovery = (lead) => {
  const qd = (lead && lead.qualificationData) || {};

  // Gate 1 — canonical event date ONLY (NOT eventDatePart, NOT the ad-form/Kiara
  // month band; see the exclusion above).
  const hasEventDate = present(qd.eventDate);
  // Gate 2 — at least one required service captured.
  const hasServices = present(qd.servicesRequired);
  // Retained for display/back-compat — does NOT gate.
  const hasName = present(lead && lead.name) || present(qd.groomName) || present(qd.brideName);

  const missing = [];
  if (!hasEventDate) missing.push("eventDate");
  if (!hasServices) missing.push("services");
  const complete = missing.length === 0;

  // Mid-qualify slice — the three-way state (ADDITIVE; complete unchanged):
  // in_progress = the gate is unmet but SOMETHING happened (any qualification
  // field captured, or any call logged). Same doc, zero extra queries.
  const started =
    anyCaptured(qd) || (Array.isArray(lead && lead.callLog) && lead.callLog.length > 0);
  const state = complete ? "complete" : started ? "in_progress" : "not_started";

  return {
    discoveryComplete: complete,
    discovery: { complete, missing, hasEventDate, hasServices, hasName, state },
  };
};

module.exports = { computeDiscovery };
