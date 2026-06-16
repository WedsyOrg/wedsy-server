// SEQ-1 — the discovery brief's completeness, COMPUTED on read (never stored, so
// it can't drift). A lead's "discovery" is complete when the four core facts are
// captured: event date, city, guest count, and services. Budget is intentionally
// NOT required.
//
// The facts live across a few shapes (a lead can be enriched by the cockpit's
// structured qualificationData OR by Kiara's extracted additionalInfo answers OR
// by the ad-form answers), so each check resolves all known paths — mirroring how
// the lead page already reads them.

const present = (v) => {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.length > 0;
  return String(v).trim().length > 0;
};

// Compute the discovery snapshot for a lead doc (a plain object or a lean doc).
const computeDiscovery = (lead) => {
  const qd = (lead && lead.qualificationData) || {};
  const ai = (lead && lead.additionalInfo) || {};
  const ka = ai.kiaraAnswers && typeof ai.kiaraAnswers === "object" ? ai.kiaraAnswers : {};
  const af = ai.adFormAnswers && typeof ai.adFormAnswers === "object" ? ai.adFormAnswers : {};

  // Event date — Kiara/ad-form captured value, or a real Event join if present.
  const eventFromEvents = Array.isArray(lead && lead.events)
    ? lead.events.some(
        (e) => Array.isArray(e && e.eventDays) && e.eventDays.some((d) => present(d && d.date))
      )
    : false;
  const hasEventDate =
    present(ka.eventDate) || present(af.weddingDate) || present(af.eventDate) || present(af.date) || eventFromEvents;
  const hasCity = present(qd.venueArea) || present(ka.city) || present(af.city) || present(af.location);
  const hasGuests =
    present(ka.guests) || present(af.guests) || present(ka.numberOfGuests) || present(af.numberOfGuests);
  const hasServices =
    (Array.isArray(qd.servicesRequired) && qd.servicesRequired.length > 0) ||
    present(ka.servicesRequired) ||
    present(af.servicesRequired);

  const missing = [];
  if (!hasEventDate) missing.push("eventDate");
  if (!hasCity) missing.push("city");
  if (!hasGuests) missing.push("guests");
  if (!hasServices) missing.push("services");
  const complete = missing.length === 0;

  return {
    discoveryComplete: complete,
    discovery: { complete, missing, hasEventDate, hasCity, hasGuests, hasServices },
  };
};

module.exports = { computeDiscovery };
