/**
 * utils/venueRoomStatus.js — what each room IS right now, for one date.
 *
 * The layout is only useful if it shows state. A floor of twelve grey chips
 * says less than a list; twelve chips coloured free / occupied / held / off is
 * the occupancy picture, which is why Occupancy stops needing to be a separate
 * view.
 *
 * ── READ FROM WHERE OCCUPANCY ALREADY LIVES ─────────────────────────────────
 * Nothing new is derived. Two existing sources, and they answer different
 * questions:
 *
 *   VenueRoomAllotment  a GUEST is in this room for these nights
 *   VenueRoomNight      this room-night is CLAIMED — which includes claims with
 *                       no allotment yet, made when a booking reserves a COUNT
 *                       of rooms at confirmation
 *
 * A held night has no allotment to find, so reading allotments alone would show
 * a room as free that the booking engine has already promised. That was the
 * whole reason VenueRoomNight carries `booking` as well as `allotment`.
 */
const VenueRoomAllotment = require("../models/VenueRoomAllotment");
const VenueRoomNight = require("../models/VenueRoomNight");
// Required for the populate below, not for a symbol. Mongoose resolves `ref`
// through its model registry, so this only worked because server.js happens to
// load every model at boot — anything requiring this file on its own got
// "Schema hasn't been registered for model VenueBooking" at runtime. Naming the
// dependency here makes it true regardless of who loaded what first.
require("../models/VenueBooking");

/** Midnight UTC of the day a Date falls on — the basis nights are stored on. */
function dayStart(d) {
  const t = new Date(d);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
}

const STATUSES = ["free", "occupied", "held", "inactive"];

/**
 * @param {object} venue   with `rooms`
 * @param {Date}   [on]    the day to answer for; defaults to today
 * @returns {Promise<Map<string, {status: string, guestName?: string, bookingId?: string, coupleName?: string}>>}
 */
async function roomStatusOn(venue, on = new Date()) {
  const from = dayStart(on);
  const to = new Date(from.getTime() + 86400000);
  const out = new Map();

  const rooms = (venue && venue.rooms) || [];
  for (const r of rooms) {
    // An inactive room is not free — it is not in service at all, and colouring
    // it the same as a bookable empty room is how one gets sold.
    out.set(String(r._id), { status: r.isActive === false ? "inactive" : "free" });
  }
  if (!rooms.length) return out;

  const [allotments, nights] = await Promise.all([
    VenueRoomAllotment.find({
      venue: venue._id,
      status: { $in: ["allotted", "checked_in"] },
      checkInAt: { $lt: to },
      checkOutAt: { $gt: from },
    })
      .populate("booking", "coupleName")
      .select("room guestName booking status")
      .lean(),
    VenueRoomNight.find({ venue: venue._id, night: { $gte: from, $lt: to } })
      .select("room allotment booking")
      .lean(),
  ]);

  // Held first, so a real allotment overwrites it — a room with both is
  // occupied, and saying "held" about a room with a guest in it is worse than
  // saying nothing.
  for (const n of nights) {
    const key = String(n.room);
    const cur = out.get(key);
    if (!cur || cur.status === "inactive") continue;
    if (!n.allotment) out.set(key, { status: "held", bookingId: n.booking ? String(n.booking) : undefined });
  }
  for (const a of allotments) {
    const key = String(a.room);
    const cur = out.get(key);
    if (!cur || cur.status === "inactive") continue;
    out.set(key, {
      status: "occupied",
      guestName: a.guestName || "",
      bookingId: a.booking ? String(a.booking._id || a.booking) : undefined,
      coupleName: (a.booking && a.booking.coupleName) || "",
      checkedIn: a.status === "checked_in",
    });
  }
  return out;
}

/** Roll a status map into the counts a legend shows. */
function statusTotals(map) {
  const totals = { free: 0, occupied: 0, held: 0, inactive: 0 };
  for (const v of map.values()) {
    if (totals[v.status] === undefined) continue;
    totals[v.status] += 1;
  }
  return totals;
}

module.exports = { roomStatusOn, statusTotals, STATUSES, dayStart };
