// ROOMS 7 slice 1 — deactivate first, then delete. And a refusal that refuses.
//
// ── WHAT THIS SUITE IS GUARDING AGAINST ─────────────────────────────────────
// The bug it replaces was not a crash. `deleteRoom` returned 200 for a room it
// had merely DEACTIVATED, and the difference lived in a boolean field nobody
// rendered. Measured on a real database before this change:
//
//   never used        → 200 {deleted:true}      room gone
//   allotment history → 200 {deactivated:true}  room STILL THERE, isActive:false
//   held nights       → 409                     room untouched
//
// A suite that only checked status codes would have passed on all three.
//
// So every case here reads the STORED SUBDOCUMENT back out of Mongo and asserts
// what is actually in it — never the response body's own account of itself. A
// delete that "worked" and left the room in the array is the exact failure this
// feature exists to make impossible, and it is invisible to a 200 check.
//
// The fixtures are built so they COULD fail: each one asserts the room was
// present before the call as well as absent after, because "not found" passes
// just as well on a room that was never created.
//
// Run: node tests/venue-room-delete.test.js
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueBooking = require("../models/VenueBooking");
const VenueRoomNight = require("../models/VenueRoomNight");
const VenueRoomAllotment = require("../models/VenueRoomAllotment");
const rooms = require("../controllers/venueRooms");
const blocks = require("../controllers/venueRoomBlocks");
const { reserveRoomNights } = require("../utils/venueRoomNights");

const TAG = `rd-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (a, b, label) => ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, r) => { const res = mockRes(); await fn(r, res); return res; };
const req = (venue, extra = {}) => ({
  params: { slug: venue.slug, ...(extra.params || {}) },
  query: extra.query || {},
  body: extra.body || {},
  venueOwner: { venueId: String(venue._id) },
});

const CHECK_IN = new Date("2036-05-10T10:00:00Z");
const CHECK_OUT = new Date("2036-05-12T10:00:00Z");
let seq = 0;
const made = [];

/**
 * THE STORED DOCUMENT, not the response. Every assertion about whether a room
 * survived goes through here — a controller can say anything it likes in its
 * body, and the one thing it cannot fake is what is in the collection.
 */
async function storedRoom(venueId, roomId) {
  const v = await Venue.findById(venueId).select("rooms").lean();
  return (v.rooms || []).find((r) => String(r._id) === String(roomId)) || null;
}
async function storedRoomNames(venueId) {
  const v = await Venue.findById(venueId).select("rooms").lean();
  return (v.rooms || []).map((r) => r.name);
}

async function fixture({ nRooms = 3, coupleName = "Priya & Arjun" } = {}) {
  seq += 1;
  const slug = `${TAG}-${seq}`;
  const venue = await Venue.create({
    name: slug, slug, city: "Bangalore", state: "Karnataka",
    rooms: Array.from({ length: nRooms }, (_, i) => ({ name: `R${i + 1}`, isActive: true })),
  });
  const lead = await VenueEnquiry.create({
    venueId: venue._id, coupleName, coupleNameManual: true,
    couplePhone: String(9800000000 + seq), stage: "booked",
  });
  const booking = await VenueBooking.create({ venue: venue._id, enquiry: lead._id, coupleName, totalValue: 100000 });
  made.push({ venue, lead });
  return { venue, lead, booking, room: venue.rooms[0] };
}

/** Deactivate through the real PATCH route, the way the screen must. */
const deactivate = (venue, room, extra = {}) =>
  call(rooms.updateRoom, req(venue, { params: { roomId: String(room._id) }, body: { isActive: false }, ...extra }));

const del = (venue, room, extra = {}) =>
  call(rooms.deleteRoom, req(venue, { params: { roomId: String(room._id) }, ...extra }));

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  console.log(`DB: ${mongoose.connection.name}`);

  try {
    console.log("\n[1. delete is REFUSED on a room that is still in service]");
    {
      const f = await fixture();
      ok(!!(await storedRoom(f.venue._id, f.room._id)), "the fixture room really exists to begin with");

      const r = await del(f.venue, f.room);
      eq(r.code, 409, "🔴 an active room is not deletable");
      eq(r.body.code, "room_active", "…and says which refusal this is");
      ok(/deactivate it first/i.test(r.body.message), `…in words: ${JSON.stringify(r.body.message)}`);
      ok(r.body.message.includes(`"${f.room.name}"`), "…naming the room");
      eq(r.body.canDeactivate, true, "…and pointing at the step that IS available");

      const after = await storedRoom(f.venue._id, f.room._id);
      ok(!!after, "🔴 THE STORED ROOM IS STILL THERE — a refusal that deleted anyway would pass a 409 check");
      eq(after.isActive, true, "…and untouched: refusing must not deactivate as a consolation");
    }

    console.log("\n[2. deactivate, then delete — and the room is ACTUALLY gone]");
    {
      const f = await fixture();
      const before = await storedRoomNames(f.venue._id);
      eq(before.length, 3, "three rooms before");

      const d = await deactivate(f.venue, f.room);
      eq(d.code, 200, "deactivating an unpromised room just works");
      eq((await storedRoom(f.venue._id, f.room._id)).isActive, false, "…and is stored as inactive");

      const r = await del(f.venue, f.room);
      eq(r.code, 200, "🔴 NOW it deletes");
      eq(r.body.deleted, true, "…and says so");
      eq(r.body.deletedName, "R1", "…naming what went, so the screen need not remember");

      const after = await storedRoom(f.venue._id, f.room._id);
      eq(after, null, "🔴 THE STORED SUBDOCUMENT IS GONE — not deactivated, gone");
      const names = await storedRoomNames(f.venue._id);
      eq(names.length, 2, "…the array really shrank");
      ok(!names.includes("R1"), "…and R1 is not in it");
      ok(names.includes("R2") && names.includes("R3"), "🔴 …while the OTHER rooms survived (a wipe would also pass 'R1 is gone')");
    }

    console.log("\n[3. a room with allotment history — refused, WITH the reason]");
    {
      const f = await fixture();
      // A stay that is OVER, so held nights cannot be what refuses. This is
      // the case that used to return 200 and silently deactivate.
      const allot = await VenueRoomAllotment.create({
        venue: f.venue._id, booking: f.booking._id, room: f.room._id,
        guestName: "Old Guest", checkInAt: new Date("2020-01-01"), checkOutAt: new Date("2020-01-03"),
        status: "checked_out",
      });
      await VenueRoomNight.create({
        venue: f.venue._id, room: f.room._id, night: new Date(Date.UTC(2020, 0, 1)),
        booking: f.booking._id, allotment: allot._id,
      });

      // Even deactivated first — history is permanent, not a missing step.
      await deactivate(f.venue, f.room);
      eq((await storedRoom(f.venue._id, f.room._id)).isActive, false, "it is deactivated");

      const r = await del(f.venue, f.room);
      eq(r.code, 409, "🔴 refused — it does NOT return 200 and quietly deactivate");
      eq(r.body.code, "room_has_history", "…as its own case, distinct from room_active");
      ok(/guest has stayed/i.test(r.body.message), `…and states the reason: ${JSON.stringify(r.body.message)}`);
      ok(r.body.message.includes(`"${f.room.name}"`), "…naming the room");
      eq(r.body.canDeactivate, false, "…and does not dangle a second step that would not help");

      ok(!!(await storedRoom(f.venue._id, f.room._id)), "🔴 the room is still stored — the history is still resolvable");
      eq(await VenueRoomAllotment.countDocuments({ _id: allot._id }), 1, "🔴 and the stay itself is untouched");
    }

    console.log("\n[4. the reason travels ON the room, so no screen offers a doomed button]");
    {
      const f = await fixture();
      const allot = await VenueRoomAllotment.create({
        venue: f.venue._id, booking: f.booking._id, room: f.room._id,
        guestName: "G", checkInAt: new Date("2020-01-01"), checkOutAt: new Date("2020-01-03"), status: "checked_out",
      });
      await deactivate(f.venue, f.room);           // R1: history + deactivated
      await deactivate(f.venue, f.venue.rooms[1]); // R2: deactivated, clean

      const list = await call(rooms.listRooms, req(f.venue));
      eq(list.code, 200, "the list reads");
      const byName = new Map(list.body.rooms.map((r) => [r.name, r]));

      eq(byName.get("R1").deletable, false, "🔴 R1 carries its verdict without anyone calling DELETE");
      eq(byName.get("R1").undeletable.code, "room_has_history", "…with the machine-readable reason");
      ok(/guest has stayed/i.test(byName.get("R1").undeletable.reason), "…and the sentence to render inline");

      eq(byName.get("R2").deletable, true, "🔴 R2 IS deletable — the flag is not just always false");
      eq(byName.get("R2").undeletable, null, "…with nothing to explain");

      eq(byName.get("R3").deletable, false, "an in-service room is not deletable either");
      eq(byName.get("R3").undeletable.code, "room_active", "…but for the reversible reason");

      // The verdict must survive a write that returns the rooms array from the
      // OTHER controller, or a type rename would blank every Delete button.
      const t = await call(rooms.addRoom, req(f.venue, { body: { name: "R9" } }));
      eq(t.code, 201, "adding a room returns state");
      eq(t.body.rooms.find((r) => r.name === "R1").deletable, false, "🔴 …and it still carries the verdict");
      eq(await VenueRoomAllotment.countDocuments({ _id: allot._id }), 1, "the fixture stay was real");
    }

    console.log("\n[5. the held-nights guard still fires, and still names the couple]");
    {
      const f = await fixture();
      const res = await reserveRoomNights({
        venue: f.venue, booking: f.booking, needed: 3, checkIn: CHECK_IN, checkOut: CHECK_OUT,
      });
      ok(res.ok && res.reserved === 3, "the fixture really reserved 3 rooms");

      // Deactivation is where the promise is raised — unchanged from ROOMS 6.
      const d = await deactivate(f.venue, f.room);
      eq(d.code, 409, "🔴 deactivating a promised room still warns");
      eq(d.body.code, "room_has_held_nights", "…with the ROOMS 6 code");
      ok(d.body.message.includes("Priya & Arjun"), `🔴 …NAMING THE COUPLE: ${JSON.stringify(d.body.message)}`);
      eq(d.body.upcoming, 2, "…and counting the nights");
      eq((await storedRoom(f.venue._id, f.room._id)).isActive, true, "…and the room stayed in service");

      // Forced through: nights released, room deactivated, then deletable.
      const forced = await deactivate(f.venue, f.room, { body: { isActive: false, acknowledgeHeldNights: true } });
      eq(forced.code, 200, "forcing proceeds");
      eq(forced.body.releasedNights.released, 2, "🔴 …and the holds were actually released, not just allowed");
      eq(await VenueRoomNight.countDocuments({ venue: f.venue._id, room: f.room._id }), 0, "🔴 …no rows left on that room");

      const r = await del(f.venue, f.room);
      eq(r.code, 200, "and now it deletes");
      eq(await storedRoom(f.venue._id, f.room._id), null, "🔴 …for real");
    }

    console.log("\n[6. a room deactivated BEFORE the guard existed still cannot slip past delete]");
    {
      const f = await fixture();
      await reserveRoomNights({ venue: f.venue, booking: f.booking, needed: 3, checkIn: CHECK_IN, checkOut: CHECK_OUT });
      // Straight to the stored doc — exactly the state a pre-ROOMS-6 deactivation
      // left behind: inactive, and still holding nights.
      await Venue.updateOne(
        { _id: f.venue._id, "rooms._id": f.room._id },
        { $set: { "rooms.$.isActive": false } }
      );
      eq((await storedRoom(f.venue._id, f.room._id)).isActive, false, "it is inactive");
      eq(await VenueRoomNight.countDocuments({ venue: f.venue._id, room: f.room._id }), 2, "…and still holds 2 nights");

      const r = await del(f.venue, f.room);
      eq(r.code, 409, "🔴 delete warns rather than orphaning them");
      eq(r.body.code, "room_has_held_nights", "…with the held-nights refusal");
      ok(r.body.message.includes("Priya & Arjun"), "…naming the couple");
      ok(/delete it anyway/i.test(r.body.message), "…in the verb the caller actually used");
      ok(!!(await storedRoom(f.venue._id, f.room._id)), "…and the room survived the refusal");

      const forced = await del(f.venue, f.room, { query: { force: "1" } });
      eq(forced.code, 200, "forcing through proceeds");
      eq(forced.body.releasedNights.released, 2, "…releasing the holds it warned about");
      eq(await storedRoom(f.venue._id, f.room._id), null, "🔴 …and the room is gone");
      eq(await VenueRoomNight.countDocuments({ venue: f.venue._id, room: f.room._id }), 0, "🔴 …with no rows behind it");
    }

    console.log("\n[7. PAST nights never block — and are no longer left dangling]");
    {
      const f = await fixture();
      await reserveRoomNights({ venue: f.venue, booking: f.booking, needed: 3, checkIn: CHECK_IN, checkOut: CHECK_OUT });
      // Age this room's rows into the past. Two DISTINCT days: (room, night) is
      // uniquely indexed, so one shared day would collide instead of testing.
      const rowIds = await VenueRoomNight.find({ venue: f.venue._id, room: f.room._id }).select("_id").lean();
      for (let i = 0; i < rowIds.length; i++) {
        await VenueRoomNight.updateOne({ _id: rowIds[i]._id }, { $set: { night: new Date(Date.UTC(2020, 0, 1 + i)) } });
      }
      eq(await VenueRoomNight.countDocuments({ venue: f.venue._id, room: f.room._id }), 2, "2 past rows, no allotment");

      await deactivate(f.venue, f.room);
      const r = await del(f.venue, f.room);
      eq(r.code, 200, "history is not a promise — a consumed night never blocks a delete");
      eq(r.body.sweptNights, 2, "🔴 …and the rows went WITH the room, reported not silent");
      eq(await storedRoom(f.venue._id, f.room._id), null, "the room is gone");
      eq(await VenueRoomNight.countDocuments({ venue: f.venue._id, room: f.room._id }), 0,
        "🔴 NO ORPHAN: before this, 2 rows stayed pointing at a room id that no longer resolved");
      // The other rooms' nights are somebody else's promise and must survive.
      eq(await VenueRoomNight.countDocuments({ venue: f.venue._id }), 4,
        "🔴 …while the two OTHER rooms kept their 4 nights (a blanket deleteMany would also pass the line above)");
    }

    console.log("\n[8. deleting a block names the rooms it would unplace, before it happens]");
    {
      const f = await fixture();
      const b = await call(blocks.addBlock, req(f.venue, { body: { name: "Garden Block", floors: ["Ground"] } }));
      eq(b.code, 201, "block created");
      const blockId = String(b.body.blocks[0]._id);

      // Placement is its OWN endpoint — a blockRef on the room patch is
      // silently ignored, which is how the first draft of this case passed a
      // deleteBlock that had nothing to delete.
      for (const room of [f.venue.rooms[0], f.venue.rooms[1]]) {
        const p = await call(blocks.placeRoom, req(f.venue, {
          params: { roomId: String(room._id) }, body: { blockRef: blockId },
        }));
        eq(p.code, 200, `${room.name} placed`);
      }
      const placed = await Venue.findById(f.venue._id).select("rooms").lean();
      eq(placed.rooms.filter((r) => String(r.blockRef) === blockId).length, 2,
        "🔴 two rooms are REALLY in the block — the refusal below has something to refuse");

      // ROOMS 7: a block is taken out of use before it can be deleted, exactly
      // like a room. The rooms-inside warning is the SECOND refusal, and it is
      // the one this case is about — see venue-block-delete for the first.
      const early = await call(blocks.deleteBlock, req(f.venue, { params: { blockId } }));
      eq(early.code, 409, "a block in use is not deletable in one click");
      eq(early.body.code, "block_active", "…for the two-step reason");
      const off = await call(blocks.updateBlock, req(f.venue, { params: { blockId }, body: { isActive: false } }));
      eq(off.code, 200, "taken out of use");

      const r = await call(blocks.deleteBlock, req(f.venue, { params: { blockId } }));
      eq(r.code, 409, "🔴 refused rather than silently unplacing them");
      eq(r.body.code, "block_in_use", "…with its own code");
      ok(/2 rooms are in Garden Block/i.test(r.body.message), `🔴 …NAMING THE COUNT: ${JSON.stringify(r.body.message)}`);
      ok(/unplaced/i.test(r.body.message), "…and saying what becomes of them");
      ok(Array.isArray(r.body.rooms) && r.body.rooms.includes("R1") && r.body.rooms.includes("R2"),
        `🔴 …and naming them: ${JSON.stringify(r.body.rooms)}`);
      ok(!r.body.rooms.includes("R3"), "…but not the room that was never in it");

      const stillThere = await Venue.findById(f.venue._id).select("blocks").lean();
      eq(stillThere.blocks.length, 1, "🔴 the block itself survived the refusal");
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
