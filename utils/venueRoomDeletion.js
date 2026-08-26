/**
 * utils/venueRoomDeletion.js — CAN THIS ROOM BE DELETED, AND IF NOT, WHY.
 *
 * ── THE BEHAVIOUR THIS REPLACES ─────────────────────────────────────────────
 * `deleteRoom` had three outcomes and admitted to one of them. Measured against
 * a real database:
 *
 *   never used            → 200 {deleted: true}      room gone            ✓
 *   allotment history     → 200 {deactivated: true}  room still there     ✗
 *   upcoming held nights  → 409 room_has_held_nights room untouched       ✓
 *
 * The middle row is the problem. A caller asked to DELETE, got a 200, and the
 * only trace of what actually happened was a boolean nobody rendered. The room
 * was still on the property, struck through, and the owner had every reason to
 * believe it was gone.
 *
 * It was deactivated for a good reason — a past guest's stay refers to that
 * room id, and deleting the room would leave the stay pointing at nothing. The
 * mistake was never the deactivation. It was doing it silently, under the name
 * of a different verb.
 *
 * So the reason now travels WITH the room, on every read, and the delete route
 * refuses out loud instead of substituting an action the caller did not ask
 * for.
 *
 * ── WHY THE REASON IS ON THE ROOM AND NOT ONLY ON THE REFUSAL ───────────────
 * A screen that offers Delete and is then refused has already failed: the owner
 * committed to a permanent-sounding action and got an error. A disabled button
 * with a tooltip is barely better — nobody reads it. The room itself has to say
 * "this one can never be deleted, and here is why", before anything is clicked.
 *
 * ── ONE DEFINITION, THREE READERS ──────────────────────────────────────────
 * The rooms list, the room-types writes, and the delete route all ask the same
 * question, so they all ask it here. Two implementations of "is this deletable"
 * is one that can drift, and the one that drifts is always the one guarding the
 * write.
 */
const VenueRoomAllotment = require("../models/VenueRoomAllotment");
const VenueRoomNight = require("../models/VenueRoomNight");

/**
 * A stay refers to this room id. That reference is the whole reason the room
 * cannot go — worth saying in those terms rather than as "it is in use", which
 * an owner would read as "right now".
 */
const HISTORY_REASON =
  "A guest has stayed in this room, so it can never be deleted — that stay still refers to it. " +
  "Deactivating takes it off the property and keeps the record readable.";

const ACTIVE_REASON =
  "Deactivate it first. Deleting cannot be undone, so it is never one click away from a room in service.";

/**
 * Which of these rooms a guest has ever been allotted.
 *
 * ONE query for the whole venue, not one per room: this runs on every rooms
 * read, and a 200-room property would otherwise issue 200 existence checks to
 * render a list.
 *
 * @returns {Promise<Set<string>>} room ids, as strings
 */
async function roomsWithHistory(venueId, rooms) {
  const ids = (rooms || []).map((r) => r._id).filter(Boolean);
  if (!ids.length) return new Set();
  const used = await VenueRoomAllotment.distinct("room", { venue: venueId, room: { $in: ids } });
  return new Set(used.map(String));
}

/**
 * The verdict for one room, given the venue's history set.
 *
 * ── HISTORY OUTRANKS "STILL IN SERVICE" ────────────────────────────────────
 * An active room with history could truthfully be told either "deactivate
 * first" or "this can never be deleted". The second is the one worth saying:
 * the first implies that deactivating will unlock a Delete button, and it will
 * not. Leading an owner through a two-step flow to a dead end is a worse lie
 * than the one this file exists to fix.
 *
 * HELD NIGHTS ARE DELIBERATELY NOT HERE. They are a warning that can be
 * acknowledged — a question, not a verdict — and folding them in would turn a
 * room the owner is allowed to delete into one the screen refuses to offer.
 * That guard lives at the write, where the acknowledgement can be given.
 */
function deletabilityFor(room, withHistory) {
  if (withHistory.has(String(room._id))) {
    return { deletable: false, undeletable: { code: "room_has_history", reason: HISTORY_REASON } };
  }
  if (room.isActive !== false) {
    return { deletable: false, undeletable: { code: "room_active", reason: ACTIVE_REASON } };
  }
  return { deletable: true, undeletable: null };
}

/**
 * Decorate already-resolved rooms with their verdict.
 * Takes resolved rooms (post-inheritance) so this never becomes a second place
 * that knows how inheritance works.
 */
async function decorateDeletability(venueId, resolvedRooms) {
  const withHistory = await roomsWithHistory(venueId, resolvedRooms);
  return (resolvedRooms || []).map((r) => ({ ...r, ...deletabilityFor(r, withHistory) }));
}

/**
 * Every room-night still pointing at a room that is about to stop existing.
 *
 * ── THE ORPHAN releaseHeldNightsForRoom DOES NOT COVER ──────────────────────
 * That function is scoped to UPCOMING nights with no allotment, and correctly
 * so: it exists to release a promise the venue can no longer keep, and a night
 * already consumed is not a promise. But "not worth blocking a delete" and "safe
 * to leave behind" are different questions, and only the first was being asked.
 *
 * Measured, before this existed: a room whose only rows were PAST holds
 * (allotment: null, night < today) deleted with a 200 and left 2 VenueRoomNight
 * documents pointing at a room id that no longer resolved. Exactly what
 * scripts/audit-orphaned-room-nights.js was written to find.
 *
 * Deleting the room is the owner's explicit, stated-as-permanent act, and these
 * rows are unreadable without it — the booking keeps its own record in
 * VenueBooking.roomsHistory, which stores roomName as text and survives. So
 * they go with the room, and the count is REPORTED rather than swept quietly.
 */
async function sweepRoomNights(venueId, roomId) {
  const { deletedCount } = await VenueRoomNight.deleteMany({ venue: venueId, room: roomId });
  return deletedCount || 0;
}

module.exports = {
  HISTORY_REASON,
  ACTIVE_REASON,
  roomsWithHistory,
  deletabilityFor,
  decorateDeletability,
  sweepRoomNights,
};
