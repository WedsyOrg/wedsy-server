/**
 * utils/venueOutOfOrder.js — a room that cannot be used for a while.
 *
 * ── WHY NOT JUST DEACTIVATE IT ──────────────────────────────────────────────
 * Deactivating is PERMANENT and removes the room from the property. An owner
 * covering a week of repairs who reaches for it has quietly shrunk their
 * inventory for good, and nothing tells them when to put it back. Out of order
 * is temporary, dated, carries a reason, and expires by itself.
 *
 * ── HOW IT DIFFERS FROM isActive, MECHANICALLY ──────────────────────────────
 * `isActive` is ABSOLUTE — activeRooms() can filter on it without knowing any
 * dates. This is DATED, so it can only be applied where the nights in question
 * are known. That is why availability filters on it inside the night-aware
 * paths rather than in activeRooms().
 *
 * Windows are [from, to): out from the 10th to the 12th means unusable on the
 * 10th and 11th, sellable again on the 12th. Same convention as every other
 * window here, and the same one nights are stored on.
 */

/** Midnight UTC of the day a Date falls on — the basis nights are stored on. */
function dayStart(d) {
  const t = new Date(d);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
}

/** The window in a uniform shape, or null when the room is in order. */
function resolveOutOfOrder(room) {
  const o = (room && room.outOfOrder) || {};
  if (!o.from || !o.to) return null;
  const from = dayStart(o.from);
  const to = dayStart(o.to);
  if (!(to > from)) return null;
  return { reason: o.reason || "", from, to, at: o.at || null, byName: o.byName || "" };
}

/** Is this room out of order on this night? */
function isOutOfOrderOn(room, night) {
  const w = resolveOutOfOrder(room);
  if (!w) return false;
  const n = dayStart(night);
  return n >= w.from && n < w.to;
}

/**
 * Is it out of order on ANY of these nights?
 *
 * Availability across a window is all-or-nothing — a guest cannot be moved out
 * for one night and back in — which is the same rule roomsFreeAcross applies to
 * occupancy. A room out of order for one night of a four-night stay is not
 * usable for that stay.
 */
function isOutOfOrderAcross(room, nights) {
  return (nights || []).some((n) => isOutOfOrderOn(room, n));
}

/** Has the window already passed? Then the room is usable again, by itself. */
function hasExpired(room, now = new Date()) {
  const w = resolveOutOfOrder(room);
  return Boolean(w && dayStart(now) >= w.to);
}

const fmtDay = (d) =>
  new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** "Out of order until 12 Sep 2036 — broken AC". One wording, everywhere. */
function describeOutOfOrder(room) {
  const w = resolveOutOfOrder(room);
  if (!w) return "";
  // `to` is exclusive, so the last unusable night is the day before it. Saying
  // "until the 12th" when the room is sellable on the 12th is how somebody
  // leaves it empty for a night nobody was paid for.
  const lastNight = new Date(w.to.getTime() - 86400000);
  const span = w.from.getTime() === lastNight.getTime()
    ? fmtDay(w.from)
    : `${fmtDay(w.from)} – ${fmtDay(lastNight)}`;
  return w.reason ? `Out of order ${span} — ${w.reason}` : `Out of order ${span}`;
}

module.exports = {
  resolveOutOfOrder, isOutOfOrderOn, isOutOfOrderAcross, hasExpired, describeOutOfOrder, dayStart,
};
