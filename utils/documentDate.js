/**
 * utils/documentDate.js — dates as they appear on a document we send someone.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * `toLocaleDateString` composes its output from the ICU/CLDR data bundled with
 * the Node build, so the SAME code prints different strings on different
 * runtimes. This is not hypothetical — it shipped:
 *
 *   Node 18.20.8 (ICU 74.2, prod)  "Thursday 26 November, 2026"
 *   Node 20.20.2 (ICU 78.2, dev)   "Thursday, 26 November 2026"
 *
 * The T&C cover page went out to couples with the comma in the wrong place,
 * and nobody could see it locally because dev renders the correct form. CLDR
 * changes with every ICU release, so this will keep happening to any date we
 * hand to Intl.
 *
 * Note what diverged and what did not. At those two ICU versions the
 * weekday-bearing format differed while the plain day/month/year format
 * happened to agree — so five of the six document date formats looked fine
 * BY LUCK. Agreement at two arbitrary versions is not a guarantee, so every
 * document date is composed here instead of only the one that visibly broke.
 *
 * ── WHAT IS AND ISN'T HANDED TO Intl ────────────────────────────────────────
 * The month and weekday NAMES and the ORDER and PUNCTUATION are ours, from the
 * tables below. That is the whole fix: those are what CLDR revises.
 *
 * The calendar arithmetic still goes through utils/venueTime, which resolves
 * days against the IANA zone rather than a hardcoded +05:30 — deliberately, so
 * it stays correct if India ever adopts DST, and so a future non-IST venue
 * works. That helper yields NUMBERS ("2026-11-27"), which are identical across
 * ICU versions (verified on both runtimes), and it already normalises the one
 * ICU quirk it depends on. Numbers in, our own words out.
 *
 * The weekday is computed arithmetically from the resolved y/m/d rather than
 * asked of Intl, because a weekday NAME from Intl would reintroduce exactly
 * the dependency this module removes.
 *
 * ── DAY KEYS vs INSTANTS ────────────────────────────────────────────────────
 * Same distinction utils/venueTime draws, and it matters here because getting
 * it wrong prints the wrong day, not merely a differently-punctuated one.
 *
 *   zone: "utc"    for CALENDAR LABELS stored as midnight UTC — event dates,
 *                  VenueSpaceDate.date, function dates. These are labels, not
 *                  moments; shifting them into a zone moves the wedding.
 *   zone: "venue"  for real INSTANTS — createdAt, issuedAt, "today". Rendered
 *                  in the venue's zone (Asia/Kolkata) because that is the
 *                  business's calendar, and because the servers run UTC, which
 *                  is nobody's idea of what day it is.
 */
const { venueDateKey, VENUE_TZ } = require("./venueTime");

const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A valid Date, or null. Never throws, never yields "Invalid Date". */
function toDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Resolve an instant to the {y, m, d} of the calendar day it falls on.
 *
 * @param {Date} d
 * @param {"utc"|"venue"} zone
 */
function parts(d, zone) {
  if (zone === "utc") {
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
  }
  // Numbers only, from the tz-database helper. No composed strings.
  const [y, m, dd] = venueDateKey(d, VENUE_TZ).split("-").map(Number);
  return { y, m, d: dd };
}

/**
 * Weekday index for a calendar date, computed rather than asked of Intl.
 * Date.UTC + getUTCDay is pure arithmetic on the proleptic Gregorian calendar —
 * no locale data involved, so it cannot drift with ICU.
 */
function weekdayIndex({ y, m, d }) {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * The one formatter. Every helper below is a named preset of it, so there is
 * exactly one place the punctuation of a document date is decided.
 *
 * @param {Date|string|number} value
 * @param {object}  [opts]
 * @param {"utc"|"venue"} [opts.zone="utc"]
 * @param {boolean} [opts.weekday=false]      prefix "Thursday, "
 * @param {"long"|"short"} [opts.month="long"]
 * @param {string}  [opts.fallback=""]        returned when the date is unusable
 */
function formatDocumentDate(value, opts = {}) {
  const { zone = "utc", weekday = false, month = "long", fallback = "" } = opts;
  const d = toDate(value);
  if (!d) return fallback;
  const p = parts(d, zone);
  const monthName = (month === "short" ? MONTHS_SHORT : MONTHS_LONG)[p.m - 1];
  const body = `${p.d} ${monthName} ${p.y}`;
  if (!weekday) return body;
  const wd = (month === "short" ? WEEKDAYS_SHORT : WEEKDAYS_LONG)[weekdayIndex(p)];
  // The comma sits after the weekday. This is the line that ICU 74 and ICU 78
  // disagreed about, and it is now ours.
  return `${wd}, ${body}`;
}

// ── presets, one per shape a document actually uses ─────────────────────────

/** "26 November 2026" — a calendar label stored at midnight UTC. */
const docDay = (v, fallback = "") => formatDocumentDate(v, { zone: "utc", fallback });

/** "Thursday, 26 November 2026" — the same label, with its weekday. */
const docDayWithWeekday = (v, fallback = "") =>
  formatDocumentDate(v, { zone: "utc", weekday: true, fallback });

/** "26 Nov 2026" — short form, for dense rows. */
const docDayShort = (v, fallback = "") =>
  formatDocumentDate(v, { zone: "utc", month: "short", fallback });

/**
 * "26 November 2026" from a bare calendar key — "2026-11-26", or anything
 * starting with one ("2026-11-26T00:00:00").
 *
 * Parsed as DIGITS, never through `new Date`, which removes a second hazard
 * beyond ICU. `new Date("2026-11-26T00:00:00")` (no Z) is parsed as LOCAL
 * midnight, so on a UTC box it is the 26th and on an IST box it is
 * 2026-11-25T18:30Z — the same string meaning two different days depending on
 * the server's timezone. A calendar label has no timezone to resolve, and this
 * treats it that way.
 */
function docDayFromKey(key, opts = {}) {
  const { month = "long", weekday = false, fallback = "" } = opts;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(key || ""));
  if (!m) return fallback;
  const p = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  if (p.m < 1 || p.m > 12 || p.d < 1 || p.d > 31) return fallback;
  const monthName = (month === "short" ? MONTHS_SHORT : MONTHS_LONG)[p.m - 1];
  const body = `${p.d} ${monthName} ${p.y}`;
  if (!weekday) return body;
  return `${(month === "short" ? WEEKDAYS_SHORT : WEEKDAYS_LONG)[weekdayIndex(p)]}, ${body}`;
}

/** "26 November 2026" for a real instant, in the venue's calendar. */
const docInstantDay = (v, fallback = "") => formatDocumentDate(v, { zone: "venue", fallback });

/** "26 Nov 2026" for a real instant, in the venue's calendar. */
const docInstantDayShort = (v, fallback = "") =>
  formatDocumentDate(v, { zone: "venue", month: "short", fallback });

module.exports = {
  formatDocumentDate,
  docDayFromKey,
  docDay,
  docDayWithWeekday,
  docDayShort,
  docInstantDay,
  docInstantDayShort,
  // Exported for the suite, which asserts the tables are complete and that no
  // preset can reach Intl.
  MONTHS_LONG,
  MONTHS_SHORT,
  WEEKDAYS_LONG,
  WEEKDAYS_SHORT,
};
