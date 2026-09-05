// HOLDS OFF — confirming writes NO VenueRoomNight rows and never refuses on
// availability. Run: node tests/venue-rooms-reserve.test.js
//
// ── THIS SUITE ONCE PINNED THE OPPOSITE ─────────────────────────────────────
// Until the founder's HOLDS OFF ruling (Sep 2026, following BOOKING 3 and
// ROOMS INVENTORY ONLY) this file asserted that confirming a lead with
// roomsNeeded RESERVED that many rooms as held VenueRoomNight rows and 409'd
// rooms_short when inventory ran short. These venues run one event at a time
// and rooms are NEVER HELD, so the sections below are deliberate INVERSIONS
// of the old [A], [B], [C] and [E] — not a regression. The old behaviour is
// behind utils/venueRoomNights.heldRoomsPolicy.NEVER_HELD, and section
// [CONTROL] flips it to prove the machinery still works and that these
// zero-row assertions could actually fail.
//
// What did NOT invert: [D] the allotment double-booking guard (the {room,
// night} unique index still protects named allotments) and [F] the drain on
// cancellation — legacy held rows from before the ruling must still empty out.
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
const { heldRoomsPolicy } = require("../utils/venueRoomNights");

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
    couplePhone: `9${Date.now()}${Math.floor(Math.random() * 999)}`.slice(0, 10),
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
const totalFor = (bookingId) => VenueRoomNight.countDocuments({ booking: bookingId });

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    await VenueSpaceDate.init();
    await VenueRoomNight.init(); // fresh-DB unique-index race (venue-crm-s2 lesson)
    venue = await Venue.create({
      name: `${TAG}-v`, slug: `${TAG}-v`,
      spaces: [{ name: "Lawn", isBookable: true }, { name: "Hall", isBookable: true }],
      rooms: Array.from({ length: ROOMS }, (_, i) => ({ name: `Room ${i + 1}`, isActive: true })),
    });
    owner = await VenueOwner.create({ venueId: venue._id, name: "Owner", phone: `${TAG}o`.slice(0, 14), isActive: true });

    // ── [A] INVERTED: confirming reserves NOTHING ──
    console.log("\n[A. confirm records the ask and holds nothing]");
    const l1 = await newLead(20, "2035-09-30T10:00:00Z", "2035-10-02T10:00:00Z");
    const r1 = await confirm(l1);
    ok(r1.code === 200, `confirm succeeds (got ${r1.code}: ${r1.body && r1.body.message})`);
    const b1 = await VenueBooking.findOne({ enquiry: l1._id }).lean();
    ok(await totalFor(b1._id) === 0, `🔴 ZERO VenueRoomNight rows written (got ${await totalFor(b1._id)}) — was "20 rooms × 2 nights are HELD"`);
    ok(b1.roomsRequired === 20, "…while roomsRequired keeps the ask as a RECORD on the booking");

    // ── [B] INVERTED: no availability refusal, ever ──
    console.log("\n[B. an overlapping wedding is never refused on rooms]");
    const l2 = await newLead(10, "2035-09-30T10:00:00Z", "2035-10-02T10:00:00Z");
    const r2 = await confirm(l2, {}, 1);
    ok(r2.code === 200, `🔴 the overlap confirms clean (got ${r2.code}${r2.body && r2.body.message ? `: ${r2.body.message}` : ""}) — was 409 rooms_short`);
    const b2 = await VenueBooking.findOne({ enquiry: l2._id }).lean();
    ok(b2 && b2.status === "confirmed" && await totalFor(b2._id) === 0, "…confirmed, and still zero rows");

    const lBig = await newLead(100, "2035-11-01T10:00:00Z", "2035-11-03T10:00:00Z");
    const rBig = await confirm(lBig);
    ok(rBig.code === 200, `🔴 needing 100 of ${ROOMS} rooms confirms clean (got ${rBig.code}) — the question is not asked`);

    await Venue.updateOne({ _id: venue._id }, { $set: { "rooms.$[].isActive": false } });
    venue = await Venue.findById(venue._id);
    const lDead = await newLead(5, "2035-11-10T10:00:00Z", "2035-11-12T10:00:00Z");
    const rDead = await confirm(lDead);
    ok(rDead.code === 200, `🔴 every room deactivated: still confirms clean (got ${rDead.code})`);
    await Venue.updateOne({ _id: venue._id }, { $set: { "rooms.$[].isActive": true } });
    venue = await Venue.findById(venue._id);

    // ── [C] INVERTED: a window move claims nothing and cannot 409 on rooms ──
    console.log("\n[C. moving the window asks no availability question]");
    const mv = await call(bookings.updateBookingWindow, req({
      params: { bookingId: String(b1._id) },
      body: { checkIn: "2035-10-05T10:00:00Z", checkOut: "2035-10-07T10:00:00Z" },
    }));
    ok(mv.code === 200, `🔴 the window moves (got ${mv.code}: ${mv.body && mv.body.message}) — door 2, rederiveRoomNights, is gated too`);
    ok(await totalFor(b1._id) === 0, "…and still zero rows after the move — nothing was re-derived");

    // ── [D] NOT inverted: the allotment double-booking guard still stands ──
    console.log("\n[D. named allotments still collide on {room, night}]");
    const roomId = String(venue.rooms[0]._id);
    const mk = (guest) => call(allotments.createAllotments, req({
      params: { bookingId: String(b1._id) },
      body: { allotments: [{ room: roomId, guestName: guest, checkInAt: "2035-10-05T10:00:00Z", checkOutAt: "2035-10-07T10:00:00Z" }] },
    }));
    const dA = await mk("Guest One");
    ok(dA.code === 201, `an allotment on a booking with no held rows inserts fresh (got ${dA.code}: ${dA.body && dA.body.message})`);
    ok(await totalFor(b1._id) === 2, "…claiming its 2 nights the pre-holds way");
    const dB = await mk("Guest Two");
    ok(dB.code !== 201 && await totalFor(b1._id) === 2,
      `🔴 the SAME room for the same nights is refused (got ${dB.code}) — the unique index still guards guests`);

    // ── [F] NOT inverted: the drains keep running on legacy rows ──
    console.log("\n[F. cancel still empties legacy held rows from before the ruling]");
    const legacyNights = [new Date("2035-10-05T00:00:00Z"), new Date("2035-10-06T00:00:00Z")];
    await VenueRoomNight.insertMany(
      legacyNights.flatMap((night) => [1, 2].map((i) => ({
        venue: venue._id, room: venue.rooms[i]._id, night, booking: b1._id, allotment: null,
      })))
    );
    ok(await totalFor(b1._id) === 6, "fixture: 4 legacy held rows seeded beside the allotment's 2");
    const cx = await call(bookings.updateBooking, req({
      params: { bookingId: String(b1._id) },
      body: { status: "cancelled" },
    }));
    ok(cx.code === 200, "the booking cancels through the ordinary PATCH");
    ok(await totalFor(b1._id) === 0, `🔴 EVERY night drains — legacy holds and allotted alike (got ${await totalFor(b1._id)})`);
    ok(cx.body.roomsReleased === 6, `…and the response counts them (got ${cx.body.roomsReleased})`);
    ok(await VenueRoomAllotment.countDocuments({ booking: b1._id, status: "cancelled" }) === 1,
      "…while the allotment RECORD survives, marked cancelled");

    // ── [CONTROL] the switch off = the old behaviour, byte for byte ──
    console.log("\n[CONTROL. with NEVER_HELD off, confirm reserves and refuses — the fixture could fail]");
    heldRoomsPolicy.NEVER_HELD = false;
    try {
      const c1 = await newLead(20, "2036-09-30T10:00:00Z", "2036-10-02T10:00:00Z");
      const rc1 = await confirm(c1);
      ok(rc1.code === 200, `switch off: confirm succeeds (got ${rc1.code}: ${rc1.body && rc1.body.message})`);
      const cb1 = await VenueBooking.findOne({ enquiry: c1._id }).lean();
      ok(await heldFor(cb1._id) === 40, `🔴 switch off: 20 rooms × 2 nights ARE held (got ${await heldFor(cb1._id)}) — the machinery is intact for Phase 2`);
      const c2 = await newLead(10, "2036-09-30T10:00:00Z", "2036-10-02T10:00:00Z");
      const rc2 = await confirm(c2, {}, 1);
      ok(rc2.code === 409 && rc2.body.code === "rooms_short",
        `🔴 switch off: the overlap 409s rooms_short again (got ${rc2.code}/${rc2.body && rc2.body.code}) — so [A]/[B] above could not pass vacuously`);
      ok(rc2.body.available === 5 && rc2.body.needed === 10, "…with the old arithmetic intact");
    } finally {
      heldRoomsPolicy.NEVER_HELD = true;
    }
    ok(heldRoomsPolicy.NEVER_HELD === true, "the switch is back on after the control");

    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error("FATAL", e);
    fail++;
  } finally {
    heldRoomsPolicy.NEVER_HELD = true;
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
