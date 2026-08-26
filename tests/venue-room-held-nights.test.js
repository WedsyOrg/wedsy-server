// ROOMS 6 slice 0 — a room cannot leave availability while it is promised.
//
// ── THE BUG THIS FIXES, WHICH WAS LIVE ──────────────────────────────────────
// deleteRoom and updateRoom guarded on VenueRoomAllotment — a GUEST ASSIGNED to
// the room. A booking that reserved a COUNT of rooms at confirmation has no
// allotment yet; that is the entire design of ROOMS 1. So the guard saw an
// unused room and removed it, and the VenueRoomNight rows stayed behind
// pointing at a room that no longer existed. The booking still counted its
// room-nights. The property could not supply them.
//
// Three paths did it: delete-never-allotted (a HARD delete), delete-with-an-
// allotment (deactivate), and PATCH { isActive: false }.
//
// ── HOW THIS SUITE IS BUILT ─────────────────────────────────────────────────
// Every case asserts the POSITIVE as well as the refusal: that the warning
// names the couple, that forcing actually proceeds, and that NO ORPHAN EXISTS
// either way. A "0 orphans" assertion alone passes when nothing happened at
// all, and passes on an empty collection — which is exactly how the production
// check for this bug came back green while proving nothing.
//
// Run: node tests/venue-room-held-nights.test.js
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueBooking = require("../models/VenueBooking");
const VenueRoomNight = require("../models/VenueRoomNight");
const VenueRoomAllotment = require("../models/VenueRoomAllotment");
const rooms = require("../controllers/venueRooms");
const { reserveRoomNights, heldNightsForRoom } = require("../utils/venueRoomNights");

const TAG = `hn-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (a, b, label) => ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, req) => { const r = mockRes(); await fn(req, r); return r; };

const CHECK_IN = new Date("2036-05-10T10:00:00Z");
const CHECK_OUT = new Date("2036-05-12T10:00:00Z");
let seq = 0;
const made = [];

async function fixture({ coupleName = "Priya & Arjun", needed = 3 } = {}) {
  seq += 1;
  const slug = `${TAG}-${seq}`;
  const venue = await Venue.create({
    name: slug, slug, city: "Bangalore", state: "Karnataka",
    rooms: Array.from({ length: 3 }, (_, i) => ({ name: `R${i + 1}`, isActive: true })),
  });
  const lead = await VenueEnquiry.create({
    venueId: venue._id, coupleName, coupleNameManual: true,
    couplePhone: String(9800000000 + seq), stage: "booked",
  });
  const booking = await VenueBooking.create({ venue: venue._id, enquiry: lead._id, coupleName, totalValue: 100000 });
  const r = await reserveRoomNights({ venue, booking, needed, checkIn: CHECK_IN, checkOut: CHECK_OUT });
  if (!r.ok) throw new Error(`fixture could not reserve: ${r.code}`);
  made.push({ venue, lead });
  return { venue, lead, booking, room: venue.rooms[0] };
}
const req = (venue, extra = {}) => ({
  params: { slug: venue.slug, ...(extra.params || {}) },
  query: extra.query || {}, body: extra.body || {},
  venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: new mongoose.Types.ObjectId() },
  venueMember: null,
});

/** Room-nights pointing at a room that is gone, or deactivated. */
async function orphans(venueId) {
  const v = await Venue.findById(venueId).lean();
  const live = new Map((v.rooms || []).map((r) => [String(r._id), r]));
  const nights = await VenueRoomNight.find({ venue: venueId }).select("room").lean();
  let gone = 0, inactive = 0;
  for (const n of nights) {
    const r = live.get(String(n.room));
    if (!r) gone += 1; else if (r.isActive === false) inactive += 1;
  }
  return { gone, inactive, total: nights.length };
}

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    console.log("\n[the premise — the fixture really does hold nights on the room under test]");
    {
      const f = await fixture();
      const held = await heldNightsForRoom(f.venue._id, f.room._id);
      eq(held.upcoming, 2, "R1 holds 2 upcoming nights");
      eq(held.bookings.length, 1, "…for one booking");
      eq(held.bookings[0].coupleName, "Priya & Arjun", "…and the couple is named, not counted");
      eq(await VenueRoomAllotment.countDocuments({ room: f.room._id }), 0,
        "🔴 …with NO allotment — which is why the old guard missed it entirely");
    }

    console.log("\n[1. DELETE a room that was never allotted — used to HARD DELETE it]");
    {
      const f = await fixture();
      // ROOMS 7: delete became a SECOND step, so an in-service room is turned
      // away before the promise is even weighed. Nothing is deleted, which is
      // the guarantee this case exists for.
      const straight = await call(rooms.deleteRoom, req(f.venue, { params: { roomId: String(f.room._id) } }));
      eq(straight.code, 409, "refused — delete is not offered on a room still in service");
      eq(straight.body.code, "room_active", "…and names the step that is missing");

      // The promise is raised at the step that actually takes the room out of
      // availability, and it still names the couple there.
      const r = await call(rooms.updateRoom, req(f.venue, {
        params: { roomId: String(f.room._id) }, body: { isActive: false },
      }));
      eq(r.code, 409, "refused");
      eq(r.body.code, "room_has_held_nights", "…with a code the UI can branch on");
      ok(/Priya & Arjun/.test(r.body.message), `…naming the couple: "${r.body.message}"`);
      ok(/10 May 2036/.test(r.body.message), "…and when");
      eq(r.body.bookings.length, 1, "…with the affected bookings itemised");
      eq(r.body.acknowledgeWith, "acknowledgeHeldNights", "…and how to proceed");
      const v = await Venue.findById(f.venue._id).lean();
      eq(v.rooms.length, 3, "🔴 and the room is still there — nothing was deleted");
      eq((await orphans(f.venue._id)).total, 6, "…with every room-night intact");
    }

    console.log("\n[2. DELETE a room that HAS an allotment — the deactivate branch]");
    {
      const f = await fixture();
      await VenueRoomAllotment.create({
        venue: f.venue._id, booking: f.booking._id, room: f.room._id,
        guestName: "A Guest", checkInAt: CHECK_IN, checkOutAt: CHECK_OUT, status: "allotted",
      });
      const r = await call(rooms.deleteRoom, req(f.venue, { params: { roomId: String(f.room._id) } }));
      eq(r.code, 409, "refused too — deactivating removes it from availability just as surely");
      const v = await Venue.findById(f.venue._id).lean();
      eq(v.rooms.find((x) => String(x._id) === String(f.room._id)).isActive, true, "…and it is still active");
    }

    console.log("\n[3. PATCH { isActive: false }]");
    {
      const f = await fixture();
      const r = await call(rooms.updateRoom, req(f.venue, { params: { roomId: String(f.room._id) }, body: { isActive: false } }));
      eq(r.code, 409, "refused");
      ok(/Priya & Arjun/.test(r.body.message), "…naming the couple");
      const v = await Venue.findById(f.venue._id).lean();
      eq(v.rooms.find((x) => String(x._id) === String(f.room._id)).isActive, true, "🔴 still active");
    }

    console.log("\n[4. what this must NOT warn about — or owners learn to click through]");
    {
      const f = await fixture();
      const rename = await call(rooms.updateRoom, req(f.venue, { params: { roomId: String(f.room._id) }, body: { name: "R1-renamed" } }));
      eq(rename.code, 200, "renaming a promised room is fine — it changes no promise");
      const reactivate = await call(rooms.updateRoom, req(f.venue, { params: { roomId: String(f.room._id) }, body: { isActive: true } }));
      eq(reactivate.code, 200, "re-activating is fine");
      const free = await fixture();
      const spare = free.venue.rooms[2];
      await VenueRoomNight.deleteMany({ venue: free.venue._id, room: spare._id });
      const off = await call(rooms.updateRoom, req(free.venue, {
        params: { roomId: String(spare._id) }, body: { isActive: false },
      }));
      eq(off.code, 200, "🔴 deactivating a room holding NOTHING raises no warning");
      const unheld = await call(rooms.deleteRoom, req(free.venue, { params: { roomId: String(spare._id) } }));
      eq(unheld.code, 200, "🔴 …and it then deletes without one either");
      const gone = await Venue.findById(free.venue._id).lean();
      eq(gone.rooms.filter((x) => String(x._id) === String(spare._id)).length, 0,
        "🔴 …and it is REALLY gone from the stored document");
    }

    console.log("\n[5. proceeding deliberately — and the holds do not survive it]");
    {
      const f = await fixture();
      const before = await VenueRoomNight.countDocuments({ booking: f.booking._id });
      eq(before, 6, "the booking holds 3 rooms × 2 nights");
      // Inactive AND still holding nights — the state a deactivation from before
      // this guard existed left behind, and the one case where a delete meets
      // the held-nights warning rather than the two-step one. Written to the
      // stored document directly, because going through updateRoom would
      // release the holds and there would be nothing left to force past.
      await Venue.updateOne(
        { _id: f.venue._id, "rooms._id": f.room._id },
        { $set: { "rooms.$.isActive": false } }
      );
      const warned = await call(rooms.deleteRoom, req(f.venue, { params: { roomId: String(f.room._id) } }));
      eq(warned.code, 409, "the delete still warns first");
      eq(warned.body.code, "room_has_held_nights", "…about the promise, not the two-step");
      const r = await call(rooms.deleteRoom, req(f.venue, { params: { roomId: String(f.room._id) }, query: { force: "1" } }));
      eq(r.code, 200, "forced through");
      eq(r.body.releasedNights.released, 2, "🔴 the 2 held nights were RELEASED, and the response says so");
      const o = await orphans(f.venue._id);
      eq(o.gone, 0, "🔴 nothing points at a room that is gone");
      eq(o.inactive, 0, "🔴 nor at a deactivated one");
      eq(await VenueRoomNight.countDocuments({ booking: f.booking._id }), 4,
        "🔴 the booking now honestly holds 4 room-nights, not 6 — a shortfall the PMS can show");
    }

    console.log("\n[6. the body acknowledgement works too, and a guest's nights are NOT torn up]");
    {
      const f = await fixture();
      const allot = await VenueRoomAllotment.create({
        venue: f.venue._id, booking: f.booking._id, room: f.room._id,
        guestName: "A Guest", checkInAt: CHECK_IN, checkOutAt: CHECK_OUT, status: "checked_in",
      });
      await VenueRoomNight.updateMany({ venue: f.venue._id, room: f.room._id }, { $set: { allotment: allot._id } });
      const r = await call(rooms.updateRoom, req(f.venue, {
        params: { roomId: String(f.room._id) }, body: { isActive: false, acknowledgeHeldNights: true },
      }));
      eq(r.code, 200, "the body flag proceeds as well as ?force=1");
      eq(r.body.releasedNights.released, 0, "no pure holds to release");
      eq(r.body.releasedNights.keptWithAllotment, 2, "🔴 the guest's 2 nights were KEPT, and reported");
      eq(await VenueRoomNight.countDocuments({ allotment: allot._id }), 2,
        "🔴 …because stranding an allotment is not an improvement on stranding a booking");
    }

    console.log("\n[7. past nights never block — an old room must stay deletable]");
    {
      const f = await fixture();
      // Two DISTINCT past dates: (room, night) is uniquely indexed, and setting
      // both rows to the same day collides rather than testing anything.
      const past = await VenueRoomNight.find({ venue: f.venue._id, room: f.room._id }).select("_id").lean();
      for (let i = 0; i < past.length; i++) {
        await VenueRoomNight.updateOne({ _id: past[i]._id }, { $set: { night: new Date(Date.UTC(2020, 0, 1 + i)) } });
      }
      const held = await heldNightsForRoom(f.venue._id, f.room._id);
      eq(held.upcoming, 0, "no upcoming nights");
      eq(held.past, 2, "…but the history is still reported");
      const off = await call(rooms.updateRoom, req(f.venue, {
        params: { roomId: String(f.room._id) }, body: { isActive: false },
      }));
      eq(off.code, 200, "deactivating raises no warning about consumed nights");
      const r = await call(rooms.deleteRoom, req(f.venue, { params: { roomId: String(f.room._id) } }));
      eq(r.code, 200, "🔴 so it deletes without a warning — history is not a promise");
      // ROOMS 7: those past rows now leave WITH the room. They used to stay,
      // pointing at a room id that no longer resolved.
      eq(r.body.sweptNights, 2, "🔴 …and the consumed rows went with it, reported");
      eq(await VenueRoomNight.countDocuments({ venue: f.venue._id, room: f.room._id }), 0,
        "🔴 …leaving no orphan behind");
    }
  } catch (err) {
    fail += 1;
    console.error("\nFATAL", err);
  } finally {
    try {
      for (const { venue, lead } of made) {
        await VenueRoomNight.deleteMany({ venue: venue._id });
        await VenueRoomAllotment.deleteMany({ venue: venue._id });
        await VenueBooking.deleteMany({ venue: venue._id });
        await VenueEnquiry.deleteMany({ _id: lead._id });
        await Venue.deleteMany({ _id: venue._id });
      }
    } catch (e) { /* best effort */ }
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  }
})();
