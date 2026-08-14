/**
 * utils/venueHoldExpiry.js — when a hold request stops being a hold.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 * Two call sites (controllers/venueCalendar.createHold and
 * controllers/adminVenuePlanner) each computed expiry as, verbatim:
 *
 *     new Date(Date.now() + holdDays * 86400000)
 *
 * N days from request, with NO relationship to the dates being held. That is
 * right in the common case and incoherent at the edges:
 *
 *   · Request a hold on 28 Sep for a 30 Sep wedding with holdExpiryDays = 5
 *     and the hold "expires" 3 Oct — three days AFTER the event it protects.
 *     A hold that outlives its own date reserves nothing.
 *   · Nothing stopped a hold being raised on a date already in the past, which
 *     is dead on arrival.
 *
 * ── THE RULE, and why ───────────────────────────────────────────────────────
 * A hold is a short window for the couple to confirm — NOT a reservation that
 * runs to the event. So the base really is N days from REQUEST: a hold taken
 * six weeks out should lapse in five days and free the date for someone else.
 * That part of today's behaviour is correct and is kept.
 *
 * What is added is the ceiling: expiry is clamped to the END of the EARLIEST
 * held day. The earliest, not the latest, because that is the first day the
 * venue must either honour or release — a 30 Sep → 2 Oct hold stops being
 * meaningful the moment 30 Sep arrives unhonoured.
 *
 * And the floor: a hold whose earliest date has already passed is refused
 * outright rather than created expired. There is nothing to reserve.
 *
 * Note what this does NOT do: it does not extend a short hold to reach the
 * event. "Expires 19 Aug" on a 30 Sep date is CORRECT and is what the setting
 * asks for — the founder's screenshot looked wrong mainly because the sentence
 * never said what the expiry meant. That is fixed in the copy, not here.
 */

const DAY_MS = 86400000;
const DEFAULT_HOLD_DAYS = 5;

/** Last representable millisecond of the UTC day a date falls in. */
function endOfUtcDay(d) {
  const x = new Date(d);
  x.setUTCHours(23, 59, 59, 999);
  return x;
}

/** The venue's configured window, defaulted and clamped to the model's range. */
function holdDaysFor(venue) {
  const n = venue && venue.settings && Number(venue.settings.holdExpiryDays);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_HOLD_DAYS;
  return Math.min(60, Math.floor(n));
}

/**
 * Resolve the expiry for a hold over `dates`.
 *
 * @param {Date[]} dates    UTC-midnight days the hold covers (sorted or not)
 * @param {object} venue    for settings.holdExpiryDays
 * @param {Date}   [now]
 * @returns {{ ok: true, expiresAt: Date, clamped: boolean, holdDays: number }}
 *        | {{ ok: false, message: string }}
 */
function resolveHoldExpiry(dates, venue, now = new Date()) {
  const list = (dates || []).filter(Boolean).map((d) => new Date(d)).sort((a, b) => a - b);
  if (!list.length) return { ok: false, message: "A hold needs at least one date" };

  const earliest = list[0];
  const lastMomentOfEarliest = endOfUtcDay(earliest);

  // FLOOR — nothing to reserve.
  if (lastMomentOfEarliest.getTime() <= now.getTime()) {
    return {
      ok: false,
      message: "That date has already passed — there is nothing left to hold.",
    };
  }

  const holdDays = holdDaysFor(venue);
  const fromRequest = new Date(now.getTime() + holdDays * DAY_MS);

  // CEILING — never outlive the date being protected.
  const clamped = fromRequest.getTime() > lastMomentOfEarliest.getTime();
  return {
    ok: true,
    expiresAt: clamped ? lastMomentOfEarliest : fromRequest,
    clamped,
    holdDays,
  };
}

/**
 * The sentence that goes on the lead's timeline.
 *
 * The old copy — "Hold requested for 2026-09-30 — expires 2026-08-19" — put two
 * unrelated dates side by side and explained neither, so a six-week gap read as
 * a bug rather than as the confirmation window it is. Saying how long they have
 * makes the same two dates obviously correct.
 */
function holdRequestedText(dateLabels, expiresAt, { clamped = false } = {}) {
  const when = dateLabels.join(", ");
  const until = new Date(expiresAt).toISOString().slice(0, 10);
  return clamped
    ? `Hold requested for ${when} — held until the date itself (${until}).`
    : `Hold requested for ${when} — they have until ${until} to confirm, or the date reopens.`;
}

module.exports = {
  DAY_MS,
  DEFAULT_HOLD_DAYS,
  endOfUtcDay,
  holdDaysFor,
  resolveHoldExpiry,
  holdRequestedText,
};
