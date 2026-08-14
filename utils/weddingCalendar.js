/**
 * utils/weddingCalendar.js — the ONE composite answer about a wedding date.
 *
 * Four facts about a calendar square were living in four places, and every
 * consumer that wanted the whole picture had to know all four rules:
 *   · is it auspicious, for whom, how strongly   (AuspiciousDate)
 *   · is it inside a season when weddings stop   (BlackoutPeriod)
 *   · do guests get the day off                  (PublicHoliday)
 *   · is it a weekend                            (the calendar itself)
 * This resolves all four at once, for one date or a whole range, so the lead
 * page, the day view, the demand map and the note composer cannot disagree
 * about the same day.
 *
 * QUERY BUDGET. A range costs THREE queries — one per collection — regardless
 * of whether the window is 1 day or 400. Never one per day. That matters
 * because the callers are already inside requests doing real work (the lead
 * read, the demand map), and it is the same discipline utils/auspiciousDates
 * set for its own lookup.
 *
 * THE RULES ARE NOT RE-DERIVED HERE. Auspicious resolution (national OR
 * matching-region, additive, strongest tier wins) stays in
 * utils/auspiciousDates; tradition matching stays in utils/weddingTraditions.
 * This file composes their answers and adds the two new collections' own
 * resolution, nothing more.
 *
 * SIGNALS, NOT PROSE. Everything here is structured. Turning it into English
 * is utils/venueCalendarNote's job, so the wording can change without touching
 * the resolution and the UI can restyle without a server round-trip.
 */
const BlackoutPeriod = require("../models/BlackoutPeriod");
const PublicHoliday = require("../models/PublicHoliday");
const { lookupRange, toDayKey, toDayStart, venueRegions, normaliseRegions } = require("./auspiciousDates");
const { cleanTraditions, traditionsMatch, parentsOf } = require("./weddingTraditions");

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Weekday name of a day key, read in UTC because a day key IS its UTC parts. */
function weekdayOf(key) {
  const d = new Date(`${key}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? "" : WEEKDAY_NAMES[d.getUTCDay()];
}

/**
 * Saturday or Sunday. Deliberately the plain definition rather than an
 * India-specific "wedding weekend": guests' leave is what this is a proxy for,
 * and that is Sat/Sun. Auspiciousness already carries the other thing.
 */
function isWeekendKey(key) {
  const d = new Date(`${key}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  const dow = d.getUTCDay();
  return dow === 0 || dow === 6;
}

/**
 * Every day key from `from` to `to` inclusive.
 *
 * Deliberately plain UTC arithmetic, NOT the venueTime IST helpers. A day key
 * is a calendar label whose stored form is midnight UTC; running it through
 * venueDayStartFromKey returns the INSTANT of IST midnight — 18:30Z the
 * previous day — which slices back to the wrong date. utils/venueTime's header
 * says exactly this; the helpers there are for instants, and these are labels.
 */
function daySpan(fromKey, toKey) {
  const out = [];
  const [y, m, d] = String(fromKey).split("-").map(Number);
  const cursor = new Date(Date.UTC(y, m - 1, d));
  for (let i = 0; i < 500; i += 1) {
    const key = cursor.toISOString().slice(0, 10);
    out.push(key);
    if (key >= toKey) break;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/**
 * Blackout periods overlapping [start, end]. Standard interval overlap: a
 * period counts when it starts on or before our end AND ends on or after our
 * start. Both ends inclusive — a wedding on the last day of Kharmas is still
 * inside Kharmas.
 */
async function blackoutsOverlapping(start, end) {
  return BlackoutPeriod.find({ startDate: { $lte: end }, endDate: { $gte: start } })
    .select("name startDate endDate traditions notes verified")
    .sort({ startDate: 1 })
    .lean();
}

/** Holidays in [start, end], national OR matching one of the venue's regions. */
async function holidaysIn(start, end, regions) {
  const or = [{ region: null }, { type: "national" }];
  if (regions.length) or.push({ region: { $in: regions } });
  return PublicHoliday.find({ date: { $gte: start, $lte: end }, $or: or })
    .select("date name type region verified")
    .sort({ date: 1 })
    .lean();
}

/**
 * The full picture for every day in [from, to].
 *
 * @param {object}   args
 * @param {object}   args.venue       a venue doc (state/city drive region resolution)
 * @param {string}   args.from        "YYYY-MM-DD"
 * @param {string}   args.to          "YYYY-MM-DD"
 * @param {string[]} [args.traditions] narrow to a community calendar; omit for all
 * @param {boolean}  [args.fillEmptyDays] include days with nothing on them
 * @returns {Promise<Map<string, DayPicture>>}
 *
 * DayPicture = {
 *   date, weekday, isWeekend,
 *   auspicious: null | { tier, traditions, traditionParents, national, regions, verified, notes },
 *   blackout:   null | { name, traditions, traditionParents, verified, notes, startDate, endDate },
 *   holidays:   [ { date, name, type, region, verified } ],
 *   verified:   boolean   // every signal present on this day has been checked
 * }
 */
async function resolveRange({ venue, from, to, traditions, fillEmptyDays = false } = {}) {
  const fromKey = toDayKey(from);
  const toKey = toDayKey(to);
  const out = new Map();
  if (!fromKey || !toKey || toKey < fromKey) return out;

  const regions = venueRegions(venue);
  const asking = cleanTraditions(traditions);
  const start = toDayStart(fromKey);
  const end = toDayStart(toKey);

  // THREE queries for the whole window, run together.
  const [auspiciousMap, blackouts, holidays] = await Promise.all([
    lookupRange({ from: fromKey, to: toKey, region: regions, traditions: asking }),
    blackoutsOverlapping(start, end),
    holidaysIn(start, end, normaliseRegions(regions)),
  ]);

  // A blackout only applies to a day if its tradition scope matches the ask.
  const relevantBlackouts = blackouts.filter((b) => traditionsMatch(b.traditions, asking));
  const holidaysByDay = new Map();
  for (const h of holidays) {
    const key = h.date.toISOString().slice(0, 10);
    if (!holidaysByDay.has(key)) holidaysByDay.set(key, []);
    holidaysByDay.get(key).push({
      date: key,
      name: h.name,
      type: h.type,
      region: h.region || null,
      verified: h.verified === true,
    });
  }

  const days = daySpan(fromKey, toKey);
  for (const key of days) {
    const auspicious = auspiciousMap.get(key) || null;
    const covering = relevantBlackouts.find(
      (b) => b.startDate.toISOString().slice(0, 10) <= key && b.endDate.toISOString().slice(0, 10) >= key
    );
    const blackout = covering
      ? {
          name: covering.name,
          traditions: cleanTraditions(covering.traditions),
          traditionParents: parentsOf(covering.traditions),
          verified: covering.verified === true,
          notes: covering.notes || "",
          startDate: covering.startDate.toISOString().slice(0, 10),
          endDate: covering.endDate.toISOString().slice(0, 10),
        }
      : null;
    const dayHolidays = holidaysByDay.get(key) || [];

    const hasAnything = Boolean(auspicious || blackout || dayHolidays.length);
    if (!hasAnything && !fillEmptyDays) continue;

    out.set(key, {
      date: key,
      weekday: weekdayOf(key),
      isWeekend: isWeekendKey(key),
      auspicious,
      blackout,
      holidays: dayHolidays,
      // One unchecked signal makes the day's whole picture provisional — the
      // owner reads it as one statement and cannot tell which half was checked.
      verified:
        (!auspicious || auspicious.verified) &&
        (!blackout || blackout.verified) &&
        dayHolidays.every((h) => h.verified),
    });
  }
  return out;
}

/** One date. Same three queries; returns the DayPicture (never null). */
async function resolveDay({ venue, date, traditions } = {}) {
  const key = toDayKey(date);
  if (!key) return null;
  const map = await resolveRange({ venue, from: key, to: key, traditions, fillEmptyDays: true });
  return map.get(key) || null;
}

/**
 * The picture for a lead's whole block (check-in → check-out), plus the block
 * shape the note needs. `dayKeys` comes from utils/venueContention.leadDays so
 * the two agree on what days a block occupies.
 */
async function resolveBlock({ venue, dayKeys, traditions } = {}) {
  const keys = (dayKeys || []).filter(Boolean).sort();
  if (!keys.length) return null;
  const map = await resolveRange({
    venue,
    from: keys[0],
    to: keys[keys.length - 1],
    traditions,
    fillEmptyDays: true,
  });
  const days = keys.map((k) => map.get(k)).filter(Boolean);
  return {
    days,
    nights: Math.max(1, keys.length),
    // The strongest claim anywhere in the block — a 2-day block with one
    // auspicious day IS an auspicious block to price.
    auspiciousDays: days.filter((d) => d.auspicious),
    blackoutDays: days.filter((d) => d.blackout),
    holidayDays: days.filter((d) => d.holidays.length),
    weekendDays: days.filter((d) => d.isWeekend),
  };
}

module.exports = {
  WEEKDAY_NAMES,
  weekdayOf,
  isWeekendKey,
  daySpan,
  blackoutsOverlapping,
  holidaysIn,
  resolveRange,
  resolveDay,
  resolveBlock,
};
