/**
 * utils/venueRoomNights.js — reserving rooms as a COUNT, with the same
 * guarantee a named allotment gets.
 *
 * ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────
 * A lead says "we need 20 rooms". The booking confirms. And nothing was held:
 *
 *     roomsNeeded: 20  →  shortfall: 20  →  no rows written
 *
 * `shortfall` was a to-do list. Until somebody opened the PMS and allotted
 * named rooms, VenueRoomNight's unique {room, night} index had nothing to
 * collide on, so two overlapping weddings could each be promised 20 of 25
 * rooms and nothing objected. That ends with two wedding parties and not
 * enough beds.
 *
 * ── HOW A HELD NIGHT IS REPRESENTED ─────────────────────────────────────────
 * A real VenueRoomNight row against a REAL room, with `allotment: null` and
 * `booking` set. Which room is an allocation detail — the couple was promised
 * a COUNT, not "Suite 2" — so the row is swappable later.
 *
 * The tempting alternative is a synthetic slot id: twenty rows of
 * {room: SLOT_1..SLOT_20, night}. It does not work, and the reason is the same
 * one that sank a sentinel-only whole-venue block: {SLOT_1, night} and
 * {<real room>, night} are DIFFERENT INDEX KEYS. They do not collide. A named
 * allotment would walk straight past twenty slot rows, and the guarantee would
 * live in whichever read paths remembered to check — application-enforced,
 * which is precisely what a unique index is for avoiding.
 *
 * Holding real rooms makes the collision structural. Nothing has to remember.
 *
 * ── WHY THE SWAP CANNOT LEAK ────────────────────────────────────────────────
 * Allotting sets `allotment` on the row that is already there. No delete, no
 * re-insert, so there is no instant — not even between two awaits — when the
 * night is free. A booking that reserved 20 and allots 20 still owns 20 rows.
 */
const mongoose = require("mongoose");
const VenueRoomNight = require("../models/VenueRoomNight");
const VenueRoomAllotment = require("../models/VenueRoomAllotment");

/** Nights covered by a stay: check-in day inclusive, check-out day exclusive. */
function nightKeys(checkInAt, checkOutAt) {
  const startDay = Date.UTC(checkInAt.getUTCFullYear(), checkInAt.getUTCMonth(), checkInAt.getUTCDate());
  const endDay = Date.UTC(checkOutAt.getUTCFullYear(), checkOutAt.getUTCMonth(), checkOutAt.getUTCDate());
  const nights = [];
  for (let t = startDay; t < endDay; t += 86400000) nights.push(new Date(t));
  // A single-day event still occupies one night of inventory.
  if (nights.length === 0) nights.push(new Date(startDay));
  return nights;
}

const dayLabel = (d) =>
  new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

/**
 * Rows belonging to a booking, including legacy rows written before
 * VenueRoomNight carried `booking`. Those are always allotted, so they are
 * reachable through their allotment — never assume the field is present.
 */
async function roomNightOwnerFilter(bookingId) {
  const allotments = await VenueRoomAllotment.find({ booking: bookingId }).select("_id").lean();
  const ids = allotments.map((a) => a._id);
  return ids.length
    ? { $or: [{ booking: bookingId }, { allotment: { $in: ids } }] }
    : { booking: bookingId };
}

/** Active, bookable rooms on the venue, in a stable order. */
const activeRooms = (venue) => (venue.rooms || []).filter((r) => r.isActive !== false);

/**
 * Which rooms are free for EVERY night of the window.
 *
 * A room that is free on three nights of four is not usable for a four-night
 * stay — a guest cannot be moved out for one night and back in — so
 * availability is all-or-nothing across the window.
 */
async function roomsFreeAcross({ venueId, rooms, nights, ignoreBookingId }) {
  const taken = await VenueRoomNight.find({
    venue: venueId,
    night: { $in: nights },
    room: { $in: rooms.map((r) => r._id) },
  })
    .select("room night booking allotment")
    .lean();

  // A booking re-deriving its own window must not treat its own current rows
  // as somebody else's occupancy.
  const ignore = ignoreBookingId ? String(ignoreBookingId) : null;
  const busy = new Set();
  const perNight = new Map(nights.map((n) => [Number(n), 0]));
  for (const t of taken) {
    if (ignore && String(t.booking || "") === ignore) continue;
    busy.add(String(t.room));
    perNight.set(Number(t.night), (perNight.get(Number(t.night)) || 0) + 1);
  }

  return {
    free: rooms.filter((r) => !busy.has(String(r._id))),
    /** Per-night occupancy, for naming WHICH date is the tight one. */
    perNight,
  };
}

/**
 * Reserve `needed` rooms for the window by writing HELD rows.
 *
 * Returns:
 *   { ok: true, reserved, rooms, nights }
 *   { ok: false, code: "rooms_short", needed, available, tightest }  — capacity
 *   { ok: false, code: "rooms_conflict" }                            — lost a race
 *
 * `allowPartial` is the acknowledgement path: with it, the venue reserves
 * everything it has and reports the shortfall rather than refusing.
 */
async function reserveRoomNights({ venue, booking, needed, checkIn, checkOut, allowPartial = false }) {
  const count = Math.max(0, Number(needed) || 0);
  if (!count || !checkIn || !checkOut) return { ok: true, reserved: 0, rooms: [], nights: [] };

  const nights = nightKeys(new Date(checkIn), new Date(checkOut));
  const rooms = activeRooms(venue);
  const { free, perNight } = await roomsFreeAcross({
    venueId: venue._id,
    rooms,
    nights,
    ignoreBookingId: booking._id,
  });

  if (free.length < count && !allowPartial) {
    // Name the tightest night — "22 already held on 30 Sept, you have 25" is
    // actionable; "not enough rooms" is not.
    let tightestNight = nights[0];
    let tightestTaken = -1;
    for (const [n, taken] of perNight.entries()) {
      if (taken > tightestTaken) { tightestTaken = taken; tightestNight = new Date(n); }
    }
    return {
      ok: false,
      code: "rooms_short",
      needed: count,
      available: free.length,
      total: rooms.length,
      tightest: { night: tightestNight, day: dayLabel(tightestNight), alreadyHeld: Math.max(0, tightestTaken) },
    };
  }

  const chosen = free.slice(0, count);
  if (!chosen.length) return { ok: true, reserved: 0, rooms: [], nights, short: count };

  const rows = [];
  for (const room of chosen) {
    for (const night of nights) {
      rows.push({ venue: venue._id, room: room._id, night, booking: booking._id, allotment: null });
    }
  }

  try {
    // ordered:true — the first collision stops the batch instead of scattering
    // partial inserts across rooms.
    await VenueRoomNight.insertMany(rows, { ordered: true });
  } catch (e) {
    // Undo only this attempt's held rows. Scoped to allotment:null so a row
    // this booking already had a GUEST in can never be caught by the rollback.
    await VenueRoomNight.deleteMany({
      booking: booking._id,
      allotment: null,
      night: { $in: nights },
      room: { $in: chosen.map((r) => r._id) },
    });
    if (e.code !== 11000) throw e;
    return { ok: false, code: "rooms_conflict" };
  }

  return {
    ok: true,
    reserved: chosen.length,
    rooms: chosen.map((r) => ({ _id: r._id, name: r.name })),
    nights,
    short: Math.max(0, count - chosen.length),
  };
}

/**
 * Re-derive a booking's held nights for a NEW window.
 *
 * Claims every new night before releasing a single old one, so a refusal
 * changes nothing — the same order rederiveCalendar() uses for space rows, and
 * for the same reason: under-blocking is the failure that sells a room twice.
 *
 * ALLOTTED rows are deliberately left alone. A named guest with dates is a
 * commitment to a person, not an allocation detail, and silently moving one
 * because the event window shifted would be a worse bug than the one this
 * build is fixing. They surface to the caller instead.
 */
async function rederiveRoomNights({ venue, booking, checkIn, checkOut, needed }) {
  const count = Math.max(0, Number(needed) || 0);
  const nights = checkIn && checkOut ? nightKeys(new Date(checkIn), new Date(checkOut)) : [];
  const nightSet = new Set(nights.map((n) => Number(n)));

  const ownerFilter = await roomNightOwnerFilter(booking._id);
  const currentHeld = await VenueRoomNight.find({ ...ownerFilter, allotment: null })
    .select("_id room night")
    .lean();
  const currentAllotted = await VenueRoomNight.find({ ...ownerFilter, allotment: { $ne: null } })
    .select("_id room night allotment")
    .lean();

  const strandedAllotments = currentAllotted.filter((r) => !nightSet.has(Number(r.night)));

  // Rooms this booking already holds that stay useful under the new window.
  const keepRooms = new Map();
  for (const r of currentHeld) {
    if (nightSet.has(Number(r.night))) keepRooms.set(String(r.room), r.room);
  }

  const rooms = activeRooms(venue);
  const { free } = await roomsFreeAcross({
    venueId: venue._id,
    rooms,
    nights,
    ignoreBookingId: booking._id,
  });

  // Prefer rooms already held by this booking, so a small shift keeps the same
  // rooms rather than churning the whole allocation.
  const preferred = free.filter((r) => keepRooms.has(String(r._id)));
  const others = free.filter((r) => !keepRooms.has(String(r._id)));
  const chosen = [...preferred, ...others].slice(0, count);

  const desired = new Set();
  for (const room of chosen) for (const night of nights) desired.add(`${room._id}|${Number(night)}`);

  const heldByKey = new Map(currentHeld.map((r) => [`${r.room}|${Number(r.night)}`, r]));
  const toAdd = [...desired].filter((k) => !heldByKey.has(k));
  const toRemove = currentHeld.filter((r) => !desired.has(`${r.room}|${Number(r.night)}`));

  // ── CLAIM ────────────────────────────────────────────────────────────────
  const added = [];
  if (toAdd.length) {
    const rows = toAdd.map((k) => {
      const [roomId, nightMs] = k.split("|");
      return {
        venue: venue._id,
        room: new mongoose.Types.ObjectId(roomId),
        night: new Date(Number(nightMs)),
        booking: booking._id,
        allotment: null,
      };
    });
    try {
      const inserted = await VenueRoomNight.insertMany(rows, { ordered: true });
      added.push(...inserted.map((d) => d._id));
    } catch (e) {
      // Roll back only what this attempt inserted, by id — never by a filter
      // that could sweep up rows the booking already legitimately held.
      await VenueRoomNight.deleteMany({ _id: { $in: added } });
      if (e.code !== 11000) throw e;
      return { ok: false, code: "rooms_conflict", nights };
    }
  }

  // ── RELEASE ──────────────────────────────────────────────────────────────
  // Only now, with every new night safely claimed.
  if (toRemove.length) {
    await VenueRoomNight.deleteMany({ _id: { $in: toRemove.map((r) => r._id) } });
  }

  return {
    ok: true,
    added: toAdd.length,
    removed: toRemove.length,
    kept: currentHeld.length - toRemove.length,
    reserved: chosen.length,
    short: Math.max(0, count - chosen.length),
    strandedAllotments,
  };
}

/**
 * Give every night back. Used when a booking is cancelled or removed.
 *
 * Held AND allotted rows go, because the stay itself is off — a night nobody
 * can see and nobody can release is worse than no guarantee at all, which is
 * exactly what cancelling a booking used to leave behind.
 */
async function releaseRoomNights(bookingId) {
  const ownerFilter = await roomNightOwnerFilter(bookingId);
  const res = await VenueRoomNight.deleteMany(ownerFilter);
  return { released: res.deletedCount || 0 };
}

module.exports = {
  nightKeys,
  reserveRoomNights,
  rederiveRoomNights,
  releaseRoomNights,
  roomNightOwnerFilter,
  roomsFreeAcross,
  activeRooms,
};
