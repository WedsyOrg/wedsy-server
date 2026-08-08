/**
 * utils/venueTime.js — the ONE place a venue "day" is defined.
 *
 * Every venue in this product operates in India. The servers run UTC. Any
 * "today" / "overdue" / "due today" computed with server-local time is
 * therefore wrong for 5h30m of every day: between 00:00 and 05:30 IST the
 * Indian calendar date has already advanced but UTC has not, so
 *   - a follow-up due today reads as "tomorrow",
 *   - yesterday's missed follow-up does not flip to "overdue" until 05:30 IST.
 * That window is exactly when an owner checks their phone before the day
 * starts, which is the moment the CRM is supposed to be most useful.
 *
 * So day boundaries are resolved against the IANA zone, not the process TZ.
 * Using the tz database (not a hardcoded +05:30) means this stays correct if
 * India ever adopts DST, and the same helpers serve any future non-IST venue
 * by passing an explicit tz.
 *
 * IMPORTANT — day KEYS vs INSTANTS. Some venue data is stored as a
 * midnight-UTC "day key" (VenueSpaceDate.date, VenueRoomNight.night, the
 * demand map's date strings). Those are calendar labels, not moments, and are
 * correctly sliced with toISOString(). Do NOT run them through these helpers.
 * These helpers are for real instants (followUpDate, dueAt, scheduledAt,
 * createdAt) that must be bucketed into an Indian calendar day.
 */

const VENUE_TZ = "Asia/Kolkata";

// Wall-clock parts of `instant` in `tz`, via the tz database.
function tzParts(instant, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const out = {};
  for (const p of dtf.formatToParts(instant)) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  // Intl renders midnight as hour 24 in some ICU versions; normalise.
  if (out.hour === 24) out.hour = 0;
  return out;
}

// Offset of `tz` at `instant`, in ms (IST → +19800000).
function tzOffsetMs(instant, tz) {
  const p = tzParts(instant, tz);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Intl has no ms; compare on whole seconds so the remainder never leaks in.
  return asUTC - Math.floor(instant.getTime() / 1000) * 1000;
}

// "YYYY-MM-DD" calendar date of `instant` in `tz`. This is the venue's idea of
// what day it is right now.
function venueDateKey(instant = new Date(), tz = VENUE_TZ) {
  const p = tzParts(instant, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

// The UTC instant at which the given venue-local calendar day begins.
// Two-pass so a day that straddles a (hypothetical) DST shift still lands on
// the true local midnight rather than an hour either side of it.
function venueDayStartFromKey(key, tz = VENUE_TZ) {
  const [y, m, d] = String(key).split("-").map(Number);
  const wallAsUTC = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
  let instant = new Date(wallAsUTC - tzOffsetMs(new Date(wallAsUTC), tz));
  instant = new Date(wallAsUTC - tzOffsetMs(instant, tz));
  return instant;
}

// Start of the venue day containing `instant` (default: now).
function startOfVenueDay(instant = new Date(), tz = VENUE_TZ) {
  return venueDayStartFromKey(venueDateKey(instant, tz), tz);
}

// Last representable millisecond of that venue day.
function endOfVenueDay(instant = new Date(), tz = VENUE_TZ) {
  const start = startOfVenueDay(instant, tz);
  const nextKey = venueDateKey(new Date(start.getTime() + 36 * 3600 * 1000), tz);
  return new Date(venueDayStartFromKey(nextKey, tz).getTime() - 1);
}

// { start, end } of the venue day containing `instant` — the shape the CRM
// dashboard/reminder code wants.
function venueDayBounds(instant = new Date(), tz = VENUE_TZ) {
  return { start: startOfVenueDay(instant, tz), end: endOfVenueDay(instant, tz) };
}

// Start of the venue day `n` days after the one containing `instant`.
// Calendar arithmetic, so it survives a DST shift that ±24h math would not.
function addVenueDays(instant, n, tz = VENUE_TZ) {
  const start = startOfVenueDay(instant, tz);
  const key = venueDateKey(new Date(start.getTime() + n * 86400000 + 12 * 3600 * 1000), tz);
  return venueDayStartFromKey(key, tz);
}

// Whole venue-days from the day containing `a` to the day containing `b`.
// Negative = in the past. This is the "3d late" / "due today" arithmetic.
function venueDayDiff(a, b = new Date(), tz = VENUE_TZ) {
  const from = startOfVenueDay(new Date(b), tz).getTime();
  const to = startOfVenueDay(new Date(a), tz).getTime();
  return Math.round((to - from) / 86400000);
}

// Bucket an instant against the venue's today. Shared by the follow-up module,
// the dashboard and the lists so all three agree by construction.
function venueDueBucket(instant, now = new Date(), tz = VENUE_TZ) {
  if (!instant) return null;
  const d = new Date(instant);
  if (Number.isNaN(d.getTime())) return null;
  const diff = venueDayDiff(d, now, tz);
  if (diff < 0) return "overdue";
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff <= 7) return "this_week";
  return "later";
}

module.exports = {
  VENUE_TZ,
  venueDateKey,
  venueDayStartFromKey,
  startOfVenueDay,
  endOfVenueDay,
  venueDayBounds,
  addVenueDays,
  venueDayDiff,
  venueDueBucket,
};
