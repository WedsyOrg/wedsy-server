// Reserving rooms as a COUNT at confirmation, and keeping that guarantee
// through allotment, window moves and cancellation.
// Run: node tests/venue-rooms-reserve.test.js
//
// ── THE BUG THIS EXISTS FOR ─────────────────────────────────────────────────
//   roomsNeeded: 20  →  shortfall: 20  →  nothing reserved
// A lead could need 20 rooms, the booking could confirm, and not one night was
// held until somebody opened the PMS and allotted named rooms by hand. Two
// overlapping weddings could each be promised 20 of 25 rooms and nothing
// objected, because VenueRoomNight's unique {room, night} index had nothing to
// collide on.
//
// ── ON WHICH PATH THESE TAKE ────────────────────────────────────────────────
// Everything goes through the controller a real caller hits —
// confirmBookingFromLead, createAllotments, updateBookingWindow, updateBooking
// — not the helpers underneath. A previous build shipped a guard that had
// never executed because the tests used a shape no real caller sends.
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueOwner = require("../models/VenueOwner");
const VenueBooking = require("../models/VenueBooking");
const VenueSpaceDate = require("../models/VenueSpaceDate");
const VenueRoomNight = require("../models/VenueRoomNight");
const VenueRoomAllotment = require("../models/VenueRoomAllotment");

const bookings = require("../controllers/venueBooking");
const allotments = require("../controllers/venueAllotment");

const TAG = `rr-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };

let venue, owner;
const ROOMS = 25;

const req = (extra = {}) => ({
  params: { slug: venue.slug, ...(extra.params || {}) },
  query: extra.query || {},
  body: extra.body || {},
  venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: owner._id },
  venueMember: null,
});

async function newLead(roomsNeeded, checkIn, checkOut) {
  return VenueEnquiry.create({
    venueId: venue._id,
    coupleName: `${TAG} couple`,
    couplePhone: `9${Date.now()}`.slice(0, 10),
    stage: "negotiating",
    checkIn: new Date(checkIn),
    checkOut: new Date(checkOut),
    datesFinalised: true,
    requirements: { roomsNeeded },
    functions: [],
  });
}

/** Confirm through the real endpoint, one function on the check-in day. */
async function confirm(lead, extraBody = {}, spaceIdx = 0) {
  const day = new Date(lead.checkIn).toISOString().slice(0, 10);
  return call(bookings.confirmBookingFromLead, req({
    params: { enquiryId: String(lead._id) },
    body: {
      functions: [{ date: day, name: "Wedding", space: String(venue.spaces[spaceIdx]._id) }],
      ...extraBody,
    },
  }));
}

const heldFor = (bookingId) => VenueRoomNight.countDocuments({ booking: bookingId, allotment: null });
const allottedFor = (bookingId) => VenueRoomNight.countDocuments({ booking: bookingId, allotment: { $ne: null } });
const totalFor = (bookingId) => VenueRoomNight.countDocuments({ booking: bookingId });

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    venue = await Venue.create({
      name: `${TAG}-v`, slug: `${TAG}-v`,
      // TWO spaces, so an overlapping booking can be tested against ROOM
      // capacity without first colliding on the space calendar.
      spaces: [{ name: "Lawn", isBookable: true }, { name: "Hall", isBookable: true }],
      rooms: Array.from({ length: ROOMS }, (_, i) => ({ name: `Room ${i + 1}`, isActive: true })),
    });
    owner = await VenueOwner.create({ venueId: venue._id, name: "Owner", phone: `${TAG}o`.slice(0, 14), isActive: true });

    // ── [A] the reservation itself ──
    console.log("\n[A. confirming reserves the COUNT, not a to-do]");
    const l1 = await newLead(20, "2035-09-30T10:00:00Z", "2035-10-02T10:00:00Z");
    const r1 = await confirm(l1);
    ok(r1.code === 200, `confirm succeeds (got ${r1.code}: ${r1.body && r1.body.message})`);
    const b1 = await VenueBooking.findOne({ enquiry: l1._id }).lean();
    // 2 nights (30 Sep, 1 Oct) × 20 rooms
    ok(await heldFor(b1._id) === 40, `20 rooms × 2 nights are HELD (got ${await heldFor(b1._id)})`);
    ok(await allottedFor(b1._id) === 0, "…and none of them is allotted to a guest yet");
    const distinctRooms = (await VenueRoomNight.distinct("room", { booking: b1._id })).length;
    ok(distinctRooms === 20, "…across 20 DISTINCT rooms — a count, held as real rooms");

    // the held rows are real rooms of this venue, not synthetic slots
    const roomIds = new Set((venue.rooms || []).map((r) => String(r._id)));
    const held = await VenueRoomNight.find({ booking: b1._id }).select("room").lean();
    ok(held.every((h) => roomIds.has(String(h.room))),
      "THE REPRESENTATION: every held row names a REAL room, so a named allotment collides on the same index key");

    // ── [B] the second wedding is warned, with numbers ──
    console.log("\n[B. insufficient inventory refuses FIRST, names the numbers]");
    const l2 = await newLead(10, "2035-09-30T10:00:00Z", "2035-10-02T10:00:00Z");
    const r2 = await confirm(l2, {}, 1);
    ok(r2.code === 409, `an overlapping booking needing 10 of the 5 remaining is refused (got ${r2.code})`);
    ok(r2.body.code === "rooms_short", "…with a machine-readable code");
    ok(r2.body.available === 5 && r2.body.needed === 10 && r2.body.total === ROOMS,
      `…and the arithmetic: 5 of 25 free, 10 needed (got available=${r2.body.available})`);
    ok(/already held on/.test(r2.body.message) && /30 Sep/.test(r2.body.message),
      `…naming the tightest DATE: "${r2.body.message.slice(0, 90)}…"`);
    ok(r2.body.acknowledgeWith === "acknowledgeRoomShortfall", "…and how to proceed deliberately");
    ok(await VenueBooking.findOne({ enquiry: l2._id }) === null,
      "NOTHING was written — the refusal is not a half-applied booking");
    ok(await VenueSpaceDate.countDocuments({ bookingRef: { $exists: true }, date: new Date("2035-09-30T00:00:00Z"), venue: venue._id }) === 1,
      "…and the calendar still shows only the FIRST booking's block — the space row was rolled back too");

    // ── [C] warn and allow ──
    console.log("\n[C. …then allows it, deliberately]");
    const r2b = await confirm(l2, { acknowledgeRoomShortfall: true }, 1);
    ok(r2b.code === 200, `with the acknowledgement it confirms (got ${r2b.code}: ${r2b.body && r2b.body.message})`);
    const b2 = await VenueBooking.findOne({ enquiry: l2._id }).lean();
    ok(await heldFor(b2._id) === 10, `it takes the 5 rooms that WERE free, across 2 nights (got ${await heldFor(b2._id)})`);
    ok(await VenueRoomNight.countDocuments({ venue: venue._id, night: new Date("2035-09-30T00:00:00Z") }) === ROOMS,
      "and the venue is now exactly full on 30 Sept — 25 of 25, never 26");

    // ── [D] allotment SWAPS, it does not double-claim ──
    console.log("\n[D. allotting 20 does not become 40]");
    const before = await totalFor(b1._id);
    const firstRooms = await VenueRoomNight.distinct("room", { booking: b1._id });
    const bulk = firstRooms.slice(0, 20).map((roomId, i) => ({
      room: String(roomId),
      guestName: `Guest ${i + 1}`,
      checkInAt: "2035-09-30T10:00:00Z",
      checkOutAt: "2035-10-02T10:00:00Z",
    }));
    const rA = await call(allotments.createAllotments, req({
      params: { bookingId: String(b1._id) },
      body: { allotments: bulk },
    }));
    ok(rA.code === 201, `20 allotments are created (got ${rA.code}: ${rA.body && rA.body.message})`);
    const after = await totalFor(b1._id);
    ok(after === before && after === 40,
      `THE PROOF: total held nights did not grow — ${before} before, ${after} after (never 80)`);
    ok(await allottedFor(b1._id) === 40, "…every night now carries a guest");
    ok(await heldFor(b1._id) === 0, "…and none is left unassigned");

    // ── [E] a window move carries the rooms ──
    console.log("\n[E. moving the window re-derives the nights]");
    const l3 = await newLead(5, "2036-03-10T10:00:00Z", "2036-03-12T10:00:00Z");
    await confirm(l3);
    const b3 = await VenueBooking.findOne({ enquiry: l3._id }).lean();
    ok(await heldFor(b3._id) === 10, "5 rooms × 2 nights held");
    const mv = await call(bookings.updateBookingWindow, req({
      params: { bookingId: String(b3._id) },
      body: { checkIn: "2036-03-14T10:00:00Z", checkOut: "2036-03-16T10:00:00Z" },
    }));
    ok(mv.code === 200, `the window moves (got ${mv.code}: ${mv.body && mv.body.message})`);
    ok(await heldFor(b3._id) === 10, "…still 10 nights — the rooms moved WITH the window");
    const onOld = await VenueRoomNight.countDocuments({ booking: b3._id, night: new Date("2036-03-10T00:00:00Z") });
    const onNew = await VenueRoomNight.countDocuments({ booking: b3._id, night: new Date("2036-03-14T00:00:00Z") });
    ok(onOld === 0, "…the old nights were RELEASED");
    ok(onNew === 5, "…and the new nights are held");

    // a shrink releases the tail
    const sh = await call(bookings.updateBookingWindow, req({
      params: { bookingId: String(b3._id) },
      body: { checkIn: "2036-03-14T10:00:00Z", checkOut: "2036-03-15T10:00:00Z" },
    }));
    ok(sh.code === 200, "the window shrinks to one night");
    ok(await heldFor(b3._id) === 5, `…and drops to 5 nights (got ${await heldFor(b3._id)})`);

    // ── [F] release on cancellation ──
    console.log("\n[F. cancelling gives the rooms back — it did not, before this]");
    ok(await totalFor(b1._id) === 40, "the first booking still holds its 40 nights");
    const cx = await call(bookings.updateBooking, req({
      params: { bookingId: String(b1._id) },
      body: { status: "cancelled" },
    }));
    ok(cx.code === 200, "the booking is cancelled through the ordinary PATCH");
    ok(await totalFor(b1._id) === 0, `EVERY night is released (got ${await totalFor(b1._id)})`);
    ok(cx.body.roomsReleased === 40, `…and the response says how many (got ${cx.body.roomsReleased})`);
    const stillThere = await VenueRoomAllotment.countDocuments({ booking: b1._id });
    ok(stillThere === 20, "…while the allotment RECORDS survive — the stay is off, the history is not rewritten");
    ok(await VenueRoomAllotment.countDocuments({ booking: b1._id, status: "cancelled" }) === 20,
      "…marked cancelled");
    ok(await VenueRoomNight.countDocuments({ venue: venue._id, night: new Date("2035-09-30T00:00:00Z") }) === 5,
      "and the venue has its rooms back — only the second booking's 5 remain on 30 Sept");

    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error("FATAL", e);
    fail++;
  } finally {
    if (venue) {
      const leads = await VenueEnquiry.find({ venueId: venue._id }).select("_id").lean();
      const ids = leads.map((l) => l._id);
      const bks = await VenueBooking.find({ enquiry: { $in: ids } }).select("_id").lean();
      await VenueRoomNight.deleteMany({ venue: venue._id });
      await VenueRoomAllotment.deleteMany({ venue: venue._id });
      await VenueBooking.deleteMany({ _id: { $in: bks.map((b) => b._id) } });
      await VenueSpaceDate.deleteMany({ venue: venue._id });
      await VenueEnquiry.deleteMany({ venueId: venue._id });
      await Venue.deleteOne({ _id: venue._id });
    }
    if (owner) await VenueOwner.deleteOne({ _id: owner._id });
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
