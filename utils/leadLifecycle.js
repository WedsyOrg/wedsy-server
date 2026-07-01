// Lead lifecycle — the single server-side source of truth for the leads-list
// "chip" buckets, plus the (separate) event-date temperature. Both the list
// query (GET /enquiry?lifecycle=…) and the counts endpoint
// (GET /enquiry/lifecycle-counts) build from the SAME fragments here, so the two
// can never disagree.
//
// BUCKETS are mutually exclusive, furthest-state-wins:
//   lost > meeting > qualified > touched > fresh
//   - lost:      isLost === true OR lostStatus === "approved"
//   - meeting:   stage === "meeting_scheduled"            (and not lost)
//   - qualified: qualified === true                       (and not meeting/lost)
//   - touched:   has ANY activity                         (and not qualified/meeting/lost)
//   - fresh:     zero activity                            (and not qualified/meeting/lost)
// `stage` is deliberately NOT used to tell fresh from touched (stage is null for
// many leads). TASK activity is intentionally excluded (separate collection).

const LIFECYCLE_KEYS = ["fresh", "touched", "qualified", "meeting", "lost"];

// ── Date helpers (shared by lifecycle "past event" + temperature) ──
// A YMD string that is also a real calendar date. The regex rejects out-of-range
// month/day (so a Mongo $regex guard approximates Date.parse validity), and the
// JS Date.parse check additionally rejects impossible days (e.g. 2026-02-30).
const YMD_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS_PER_MONTH = 30.44; // avg calendar month — for the "Nmo" label rounding
const toYMD = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};
// Add n calendar months (JS rolls day overflow forward; fine for fuzzy thresholds).
const addMonths = (d, n) => { const x = new Date(d.getTime()); x.setMonth(x.getMonth() + n); return x; };

// "Valid PAST event date" (event already occurred, strictly before start of
// today) — a derived, display-only LOST signal. The $regex keeps "" / malformed
// out, so only genuine past dates fold to lost; `$lt today` is a string compare
// (ISO dates sort chronologically). `today` is the same start-of-today boundary
// used for temperature, passed in per request.
const pastEventLost = (today) => ({
  "qualificationData.eventDate": { $regex: YMD_RE, $lt: today },
});

// ── Atomic exclusions (each is collision-free under $and) ──
// NOT_LOST now also excludes valid-past-event leads (via $nor) so they don't
// double-count: a past-event lead leaves meeting/qualified/touched/fresh and
// joins lost only. Empty/malformed eventDate is NOT past → unaffected.
const notLost = (today) => ({
  isLost: { $ne: true },
  lostStatus: { $ne: "approved" },
  $nor: [pastEventLost(today)],
});
const NOT_MEETING = { stage: { $ne: "meeting_scheduled" } };
const NOT_QUALIFIED = { qualified: { $ne: true } };

// ── Activity test (touched) and its exact complement (fresh) ──
// `firstCalledAt: {$ne:null}` and the array `.0` existence checks treat a missing
// field as "no activity"; `updates.notes: {$gt:""}` matches a non-empty string
// only (a missing/empty/null note is NOT activity). Each fresh condition is the
// precise negation of its touched counterpart, so touched ∪ fresh partitions the
// (not-lost, not-meeting, not-qualified) space with no overlap and no gap.
const HAS_ACTIVITY = {
  $or: [
    { firstCalledAt: { $ne: null } },
    { "callLog.0": { $exists: true } },
    { "followUps.0": { $exists: true } },
    { "updates.notes": { $gt: "" } },
    { "updates.conversations.0": { $exists: true } },
  ],
};
const NO_ACTIVITY = {
  $and: [
    { firstCalledAt: null },
    { "callLog.0": { $exists: false } },
    { "followUps.0": { $exists: false } },
    { "updates.notes": { $not: { $gt: "" } } },
    { "updates.conversations.0": { $exists: false } },
  ],
};

// Returns the Mongo query fragment selecting EXACTLY the given bucket (encoding
// the furthest-wins exclusions: LOST [explicit OR valid past event] > meeting >
// qualified > touched > fresh). Self-contained — safe to AND into any query.
// `today` is the start-of-today YMD string (from temperatureCutoffs().today).
// Unknown key → null (caller should ignore).
function lifecycleFragment(key, today) {
  const NOT_LOST = notLost(today);
  switch (key) {
    case "lost":
      return { $or: [{ isLost: true }, { lostStatus: "approved" }, pastEventLost(today)] };
    case "meeting":
      return { $and: [NOT_LOST, { stage: "meeting_scheduled" }] };
    case "qualified":
      return { $and: [NOT_LOST, NOT_MEETING, { qualified: true }] };
    case "touched":
      return { $and: [NOT_LOST, NOT_MEETING, NOT_QUALIFIED, HAS_ACTIVITY] };
    case "fresh":
      return { $and: [NOT_LOST, NOT_MEETING, NOT_QUALIFIED, NO_ACTIVITY] };
    default:
      return null;
  }
}

// ── In-memory per-document classifier ──
// The EXACT JS mirror of lifecycleFragment's precedence, for decorating each list
// row with `row.lifecycle`. Each predicate below mirrors one Mongo condition (and
// shares the same YMD_RE + start-of-today boundary), so the in-memory bucket and
// the Mongo fragment select the same bucket for every lead. The sift self-check
// in tests asserts bucketOf === fragment across samples (guards against drift).

// Mirrors pastEventLost: { eventDate: { $regex: YMD_RE, $lt: today } }.
const isPastEventLead = (lead, today) => {
  const ed = lead && lead.qualificationData && lead.qualificationData.eventDate;
  return typeof ed === "string" && YMD_RE.test(ed) && ed < today;
};
// Mirrors HAS_ACTIVITY's $or (and is the exact negation of NO_ACTIVITY):
//   firstCalledAt {$ne:null} | callLog.0 | followUps.0 | notes {$gt:""} | conversations.0
const hasActivity = (lead) => {
  if (!lead) return false;
  const u = lead.updates || {};
  return (
    lead.firstCalledAt != null ||
    (Array.isArray(lead.callLog) && lead.callLog.length > 0) ||
    (Array.isArray(lead.followUps) && lead.followUps.length > 0) ||
    (typeof u.notes === "string" && u.notes > "") ||
    (Array.isArray(u.conversations) && u.conversations.length > 0)
  );
};
// Furthest-wins precedence — identical order to lifecycleFragment. The early
// returns encode the NOT_LOST / NOT_MEETING / NOT_QUALIFIED exclusions.
function bucketOf(lead, today) {
  if (!lead) return "fresh";
  if (lead.isLost === true || lead.lostStatus === "approved" || isPastEventLead(lead, today)) return "lost";
  if (lead.stage === "meeting_scheduled") return "meeting";
  if (lead.qualified === true) return "qualified";
  if (hasActivity(lead)) return "touched";
  return "fresh";
}

// ── Temperature (event-date based) — additive, SEPARATE from lifecycle ──
// Source: qualificationData.eventDate, a STRING "YYYY-MM-DD" (may be "" / malformed).
//   (past)    = event before today          → null (it's LOST now, no urgency)
//   Hot       = event < 2 months away        (today <= eventDate < +2mo)
//   Potential = event 2–6 months away        (+2mo <= eventDate < +6mo)
//   Cold      = event > 6 months away         (eventDate >= +6mo)
// No / unparseable / PAST eventDate => null (never defaults to cold/hot). Because
// ISO date strings sort lexicographically == chronologically, we compare on the
// raw string field; the YMD-regex guard keeps "" and malformed values out.
const TEMPERATURE_KEYS = ["hot", "potential", "cold"];

// Compute the string cutoffs once per request (from "now") so the per-row label,
// the temperature filter, AND the lifecycle "past event" boundary all use the
// identical start-of-today boundary + month thresholds (single source).
function temperatureCutoffs(now = new Date()) {
  return {
    today: toYMD(now),
    plus2mo: toYMD(addMonths(now, 2)),
    plus6mo: toYMD(addMonths(now, 6)),
  };
}

// A valid YMD string that is also a real calendar date ("2026-13-45" → false).
function isValidEventDate(s) {
  if (typeof s !== "string" || !YMD_RE.test(s)) return false;
  const t = Date.parse(s);
  return !Number.isNaN(t);
}

// Per-row label for the list response. null when no/invalid OR past eventDate
// (a past-event lead is classified lost, so it carries no temperature).
function temperatureOf(eventDate, cutoffs) {
  if (!isValidEventDate(eventDate)) return null;
  if (eventDate < cutoffs.today) return null; // past → lost, no temperature
  if (eventDate < cutoffs.plus2mo) return "hot";
  if (eventDate < cutoffs.plus6mo) return "potential";
  return "cold";
}

// Compact, ready-to-render time-to-event label ("3wk" | "4mo" | "9mo"). null when
// temperature is null (no/invalid/past date). < ~8 weeks away → weeks, else months
// rounded. Computed from the SAME today boundary as temperature/lifecycle.
function temperatureLabelOf(eventDate, cutoffs) {
  if (!temperatureOf(eventDate, cutoffs)) return null;
  const days = Math.round((Date.parse(eventDate) - Date.parse(cutoffs.today)) / DAY_MS);
  if (days < 56) return `${Math.max(1, Math.round(days / 7))}wk`; // < ~8 weeks → weeks
  return `${Math.round(days / DAYS_PER_MONTH)}mo`;
}

// Mongo fragment selecting ONLY leads that HAVE a valid eventDate in the range.
// The YMD-regex requirement excludes "" / malformed (so "cold" can never sweep
// in the dateless leads); "hot" also excludes PAST dates (they're lost, not hot),
// keeping the filter aligned with the temperature field. Unknown key → null.
function temperatureFilter(key, cutoffs) {
  if (!TEMPERATURE_KEYS.includes(key)) return null;
  const path = "qualificationData.eventDate";
  const valid = { [path]: { $regex: YMD_RE } };
  if (key === "hot") {
    return { $and: [valid, { [path]: { $gte: cutoffs.today, $lt: cutoffs.plus2mo } }] };
  }
  if (key === "potential") {
    return { $and: [valid, { [path]: { $gte: cutoffs.plus2mo, $lt: cutoffs.plus6mo } }] };
  }
  // cold
  return { $and: [valid, { [path]: { $gte: cutoffs.plus6mo } }] };
}

// ── Date-status (per-day event-draft flags) — additive, event-date family ──────
// Orthogonal to temperature (which reads the derived scalar eventDate): these
// select on the per-day flags in qualificationData.eventDays. "tentative" = any
// day marked approximate; "unknown" = any day marked "dates not finalised".
const DATE_STATUS_KEYS = ["tentative", "unknown"];

function dateStatusFragment(key) {
  if (key === "tentative") return { "qualificationData.eventDays": { $elemMatch: { tentative: true } } };
  if (key === "unknown") return { "qualificationData.eventDays": { $elemMatch: { dateUnknown: true } } };
  return null;
}

// Parse the ?dateStatus param (comma-list or array) → whitelisted keys only.
function parseDateStatus(raw) {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : String(raw).split(",");
  return arr.map((s) => s.trim()).filter((k) => DATE_STATUS_KEYS.includes(k));
}

module.exports = {
  LIFECYCLE_KEYS,
  lifecycleFragment,
  bucketOf,
  TEMPERATURE_KEYS,
  temperatureCutoffs,
  temperatureOf,
  temperatureLabelOf,
  temperatureFilter,
  isValidEventDate,
  DATE_STATUS_KEYS,
  dateStatusFragment,
  parseDateStatus,
};
