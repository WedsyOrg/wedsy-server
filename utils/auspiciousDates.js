/**
 * utils/auspiciousDates.js — the ONE place "is this date auspicious?" is answered.
 *
 * Resolution rule (the whole contract, in one sentence): a date is auspicious
 * for a venue when a NATIONAL row (region = null) OR a row matching that
 * venue's region exists. National and regional rows are additive claims, not
 * an override chain — a regional row never cancels a national one, and the
 * absence of a regional row never cancels anything either.
 *
 * WHY A BULK LOOKUP EXISTS. Calendars and demand maps ask about 30–120 days at
 * a time. Asking per day is 120 round trips to answer one screen, and the
 * demand map already runs inside a request that is doing real work. So
 * `lookupRange` is ONE query for the whole window, returning a Map keyed by
 * "YYYY-MM-DD" that callers index in O(1). `isAuspicious` exists for the
 * genuinely-single-date case (a lead's event date) and is one query too.
 *
 * DAY KEYS, NOT INSTANTS. Rows are stored at midnight UTC of the calendar date
 * (see models/AuspiciousDate). Callers pass either a "YYYY-MM-DD" string or a
 * Date. A Date is interpreted as the INDIAN calendar day it falls in, via
 * utils/venueTime — which is correct for both of the shapes that reach us:
 * a stored midnight-UTC day key (00:00Z reads as 05:30 IST, same date) and a
 * real instant (20:30Z on the 25th is already the 26th in India, and the 26th
 * is the date a couple would call it).
 */
const AuspiciousDate = require("../models/AuspiciousDate");
const { venueDateKey } = require("./venueTime");
const { cleanTraditions, traditionsMatch, parentsOf } = require("./weddingTraditions");

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "YYYY-MM-DD" for a day-key string or an instant. Null when unparseable. */
function toDayKey(input) {
  if (input == null) return null;
  if (typeof input === "string" && DAY_KEY_RE.test(input.trim())) {
    const key = input.trim();
    // Reject impossible calendar dates ("2026-02-31") rather than silently
    // rolling them forward the way Date.UTC would.
    const [y, m, d] = key.split("-").map(Number);
    const probe = new Date(Date.UTC(y, m - 1, d));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
    return key;
  }
  const dt = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(dt.getTime())) return null;
  return venueDateKey(dt);
}

/** Midnight UTC of that calendar date — the stored form. Null when unparseable. */
function toDayStart(input) {
  const key = toDayKey(input);
  if (!key) return null;
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** The y/m/d a row denormalises, straight off its day key. */
function dayParts(key) {
  const [year, month, day] = String(key).split("-").map(Number);
  return { year, month, day };
}

/**
 * The region strings a venue should be matched on, most specific first.
 * State then city, because muhurat traditions travel with the linguistic /
 * state region rather than the municipality. Both are offered so a venue team
 * that entered "Bangalore" and one that entered "Karnataka" both resolve —
 * a controlled region vocabulary is a follow-up, not a silent mismatch today.
 */
function venueRegions(venue) {
  if (!venue) return [];
  return [venue.state, venue.city].map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean);
}

// Normalise the caller's region argument to a list. "" / null / [] all mean
// "national only", which is the correct answer for a venue with no region set:
// it still gets every nationally auspicious date.
function normaliseRegions(region) {
  if (region == null) return [];
  const list = Array.isArray(region) ? region : [region];
  return list.map((r) => (typeof r === "string" ? r.trim() : "")).filter(Boolean);
}

// The one filter both readers share: national OR any of the caller's regions.
function resolutionFilter(regions) {
  const or = [{ region: null }];
  if (regions.length) or.push({ region: { $in: regions } });
  return or;
}

// Tier is a claim about strength, so when several rows cover one date the
// STRONGEST claim is what the date is. Unspecified never outranks a stated tier.
const TIER_RANK = { major: 2, moderate: 1 };
function strongestTier(rows) {
  let best = null;
  for (const r of rows) {
    if (!r.tier) continue;
    if (best === null || TIER_RANK[r.tier] > TIER_RANK[best]) best = r.tier;
  }
  return best;
}

/** Collapse every row covering one date into the single answer a UI renders. */
function summarise(key, rows) {
  // Traditions UNION across the covering rows, same additive logic as regions:
  // if a national row says north_indian and a Karnataka row says kannada, the
  // date is auspicious for both, and the owner should be told both.
  const traditions = [...new Set(rows.flatMap((r) => cleanTraditions(r.traditions)))];
  return {
    date: key,
    auspicious: true,
    tier: strongestTier(rows),
    national: rows.some((r) => !r.region),
    regions: [...new Set(rows.map((r) => r.region).filter(Boolean))],
    // Specific tokens as entered, plus the parent-level rollup owner copy uses.
    traditions,
    traditionParents: parentsOf(traditions),
    // A date is only "verified" when EVERY row behind it has been checked. One
    // unverified row makes the whole answer provisional, because the owner sees
    // one merged claim and cannot know which half was checked.
    verified: rows.length > 0 && rows.every((r) => r.verified === true),
    notes: rows.map((r) => r.notes).filter(Boolean),
  };
}

/**
 * Single date. Returns a boolean — use lookupRange when asking about more than
 * a couple of dates.
 * @param {string|Date} date
 * @param {string|string[]|null} region  omit / null for national-only
 */
async function isAuspicious(date, region) {
  const start = toDayStart(date);
  if (!start) return false;
  const row = await AuspiciousDate.findOne({ date: start, $or: resolutionFilter(normaliseRegions(region)) })
    .select("_id")
    .lean();
  return Boolean(row);
}

/**
 * Every auspicious date in [from, to], resolved for `region`, in ONE query.
 * @returns {Promise<Map<string, {date,auspicious,tier,national,regions,notes}>>}
 *          keyed by "YYYY-MM-DD"; a date absent from the map is not auspicious.
 */
async function lookupRange({ from, to, region, traditions, allRegions = false } = {}) {
  const start = toDayStart(from);
  const end = toDayStart(to);
  const out = new Map();
  if (!start || !end || end < start) return out;

  // allRegions is the ADMIN view: the people maintaining this data need to see
  // every row, including regions no venue of ours is in yet, or a wrong entry
  // for Kerala would be invisible until a Kerala venue signed up. Never used by
  // a venue-facing read — those must stay region-resolved.
  const rows = await AuspiciousDate.find({
    date: { $gte: start, $lte: end },
    ...(allRegions ? {} : { $or: resolutionFilter(normaliseRegions(region)) }),
  })
    .select("date region tier notes traditions verified")
    .sort({ date: 1 })
    .lean();

  // Tradition filtering happens in JS, not in the query, on purpose: the rule
  // includes "an empty traditions[] applies to everyone", which Mongo cannot
  // express as one index-friendly predicate, and the row set for a window is
  // already small. Omitting `traditions` asks for everything — the right
  // default, since a venue serves every community until told otherwise.
  const asking = cleanTraditions(traditions);
  const kept = asking.length ? rows.filter((r) => traditionsMatch(r.traditions, asking)) : rows;

  const byKey = new Map();
  for (const r of kept) {
    const key = r.date.toISOString().slice(0, 10);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  for (const [key, group] of byKey) out.set(key, summarise(key, group));
  return out;
}

/**
 * The same window as a Set of day keys — for callers that only need membership
 * (heat colouring a calendar) and would otherwise ignore the summary objects.
 */
async function auspiciousKeys(args) {
  return new Set((await lookupRange(args)).keys());
}

module.exports = {
  toDayKey,
  toDayStart,
  dayParts,
  venueRegions,
  normaliseRegions,
  isAuspicious,
  lookupRange,
  auspiciousKeys,
};
