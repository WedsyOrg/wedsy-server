/**
 * utils/venueHousekeeping.js — is this room READY, as distinct from whether it
 * is free.
 *
 * ── A SECOND AXIS, NOT A FIFTH STATUS ───────────────────────────────────────
 * utils/venueRoomStatus answers "is anyone in it": free / occupied / held /
 * inactive. Housekeeping answers something orthogonal, and the two combine in
 * every direction that matters:
 *
 *   free + dirty        just vacated, cannot be sold until serviced
 *   free + clean        genuinely ready
 *   occupied + dirty    a guest is in it and it has not been serviced today
 *   held + clean        promised to a booking, and ready for them
 *
 * Folding "dirty" into the status enum would make it erase "held" — precisely
 * the bug venueRoomStatus's own comment warns about, where saying "held" about
 * a room with a guest in it is worse than saying nothing. So this rides
 * alongside, never inside.
 *
 * ── ABSENT IS ITS OWN STATE ─────────────────────────────────────────────────
 * A room nobody has ever assessed is NOT clean and NOT dirty — it is untracked,
 * and the layout shows no badge at all. That is what makes shipping this a
 * no-op for every existing room: nothing is written, nothing is inferred, and
 * a property that never opens the housekeeping surface reads exactly as it does
 * today.
 *
 * ── AND NOTHING IS INFERRED FROM THE CHECK-OUT RECORD ───────────────────────
 * Check-out already stores a `checklist` of free-text items and a `damages`
 * list. Neither answers this. A room with every checklist item ticked and no
 * damages is still dirty — somebody has to service it — and a room can be
 * spotless while a damage charge is unpaid. Reading a status out of that free
 * text would be inventing a fact nobody recorded.
 */

/** clean → the room is serviced. dirty → it is not. inspected → a supervisor checked. */
const HOUSEKEEPING_STATUSES = ["clean", "dirty", "inspected"];

const LABELS = { clean: "Clean", dirty: "Dirty", inspected: "Inspected" };

/**
 * The room's housekeeping, in a uniform shape whatever it holds.
 * `status: null` means never assessed — distinct from every other value.
 */
function resolveHousekeeping(room) {
  const h = (room && room.housekeeping) || {};
  const status = HOUSEKEEPING_STATUSES.includes(h.status) ? h.status : null;
  return {
    status,
    label: status ? LABELS[status] : null,
    at: h.at || null,
    byName: h.byName || "",
    /** Serviced and ready to sell. Inspected implies clean; untracked does not. */
    ready: status === "clean" || status === "inspected",
    tracked: status !== null,
  };
}

/**
 * Every status is settable by a human at any time, deliberately.
 *
 * These are OBSERVATIONS ABOUT PHYSICAL REALITY, not a workflow. A supervisor
 * who walks into an "inspected" room and finds it filthy must be able to say
 * so; refusing the transition because the state machine disallows it would
 * make the record disagree with the room. What matters is recording WHO said it
 * and WHEN, which is what settles the argument later.
 */
function isValidStatus(s) {
  return HOUSEKEEPING_STATUSES.includes(s);
}

/** The one automatic transition: a guest left, so the room needs servicing. */
const ON_CHECK_OUT = "dirty";

module.exports = { HOUSEKEEPING_STATUSES, LABELS, resolveHousekeeping, isValidStatus, ON_CHECK_OUT };
