// ROOMS 6 slice 1 — housekeeping status, as a SECOND AXIS.
//
// The load-bearing assertions:
//
//   1. IT SURVIVES OCCUPANCY. roomStatusOn's loops REPLACE map entries rather
//      than merging them, so a naive implementation has housekeeping silently
//      erased on exactly the rooms that have a guest or a hold — the ones that
//      matter. Asserted directly on occupied and held rooms, not just free ones.
//   2. ABSENT IS ITS OWN STATE. A room nobody has assessed is neither clean nor
//      dirty, stores NOTHING, and reads exactly as it does today.
//   3. NOTHING IS INFERRED FROM CHECK-OUT'S CHECKLIST. Every item ticked, no
//      damages — still dirty, because somebody has to service it.
//
// Run: node tests/venue-housekeeping.test.js
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueOwner = require("../models/VenueOwner");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueBooking = require("../models/VenueBooking");
const VenueRoomNight = require("../models/VenueRoomNight");
const VenueRoomAllotment = require("../models/VenueRoomAllotment");
const rooms = require("../controllers/venueRooms");
const roomBlocks = require("../controllers/venueRoomBlocks");
const checkin = require("../controllers/venueCheckin");
const { roomStatusOn, statusTotals } = require("../utils/venueRoomStatus");
const { resolveHousekeeping } = require("../utils/venueHousekeeping");
const { reserveRoomNights } = require("../utils/venueRoomNights");
const { ROLE_CAPABILITIES } = require("../utils/venueRoles");

const TAG = `hk-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (a, b, label) => ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, req) => { const r = mockRes(); await fn(req, r); return r; };

const DAY = new Date("2036-07-10T12:00:00Z");
const IN = new Date("2036-07-10T10:00:00Z");
const OUT = new Date("2036-07-12T10:00:00Z");
let venue, owner, lead, booking;
const req = (extra = {}) => ({
  params: { slug: venue.slug, ...(extra.params || {}) },
  query: extra.query || {}, body: extra.body || {},
  venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: owner._id },
  venueMember: null,
});
const fresh = () => Venue.findById(venue._id).lean();
const hkOf = async (roomId) => {
  const v = await fresh();
  return resolveHousekeeping(v.rooms.find((r) => String(r._id) === String(roomId)));
};

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    venue = await Venue.create({
      name: `${TAG}`, slug: `${TAG}`, city: "Bangalore", state: "Karnataka",
      rooms: Array.from({ length: 4 }, (_, i) => ({ name: `10${i + 1}`, isActive: true })),
    });
    owner = await VenueOwner.create({ venueId: venue._id, name: "Owner", phone: `${TAG}o`.slice(0, 14), isActive: true });
    lead = await VenueEnquiry.create({
      venueId: venue._id, coupleName: "Priya & Arjun", coupleNameManual: true,
      couplePhone: "9800009191", stage: "booked",
    });
    booking = await VenueBooking.create({ venue: venue._id, enquiry: lead._id, coupleName: "Priya & Arjun", totalValue: 100000 });

    const [r1, r2, r3, r4] = venue.rooms;

    console.log("\n[absent is its own state — and shipping this changes nothing]");
    eq((await fresh()).rooms[0].housekeeping, undefined, "🔴 an unassessed room stores NOTHING");
    const h0 = await hkOf(r1._id);
    eq(h0.status, null, "…resolves to null, not to clean and not to dirty");
    eq(h0.tracked, false, "…and reports itself untracked, so the layout shows no badge");
    eq(h0.ready, false, "…and is not claimed to be ready");
    const before = await roomStatusOn(await fresh(), DAY);
    eq(before.get(String(r1._id)).status, "free", "…while occupancy reads exactly as it always has");
    eq(before.get(String(r1._id)).housekeeping, undefined, "…with no housekeeping field at all");

    console.log("\n[the endpoint]");
    const set = (roomId, status) => call(roomBlocks.setHousekeeping, req({ params: { roomId: String(roomId) }, body: { status } }));
    eq((await set(r1._id, "dirty")).code, 200, "a room can be marked dirty");
    eq((await hkOf(r1._id)).status, "dirty", "…and it sticks");
    eq((await hkOf(r1._id)).byName, "Owner", "🔴 …with WHO said so — the whole value of the record");
    ok((await hkOf(r1._id)).at instanceof Date, "…and when");
    eq((await set(r1._id, "clean")).code, 200, "housekeeping clears it");
    eq((await hkOf(r1._id)).ready, true, "…and it reads ready");
    eq((await set(r1._id, "inspected")).code, 200, "a supervisor can inspect it");
    eq((await hkOf(r1._id)).ready, true, "…which also reads ready");
    eq((await set(r1._id, "spotless")).code, 400, "an unknown status is refused");

    // ── THE SHAPE, WHICH IS THE WHOLE POINT OF WHERE THIS HANDLER LIVES ─────
    // It first returned venueRooms' rooms-state payload. The drawer merged that
    // straight into `layoutState`, which then had no `layout` key, and the
    // entire floor plan vanished from the screen. Same defect ROOMS 3 found:
    // a write endpoint answering in a shape the read endpoint never returns.
    const shaped = await set(r1._id, "inspected"); // leaves r1 as the later cases expect
    ok(Array.isArray(shaped.body.layout), "🔴 it answers with the LAYOUT payload the read endpoint returns");
    ok(shaped.body.counts && shaped.body.counts.status, "…counts and all");
    const readBack = await call(roomBlocks.getLayout, req({ query: { withStatus: "1" } }));
    // A SUPERSET, not an exact match. placeRoom already adds `roomId`, and an
    // extra key is harmless when the client merges. A MISSING key is what
    // empties the screen, so that is what this asserts.
    const missing = Object.keys(readBack.body).filter((k) => !(k in shaped.body));
    eq(missing.join(",") || "(none)", "(none)",
      "🔴 …carrying every key the read endpoint returns, so merging it cannot empty the screen");

    console.log("\n[🔴 the second axis survives occupancy — where a naive merge loses it]");
    // r2 gets a GUEST, r3 gets a HELD night. Both are rooms whose map entry the
    // occupancy loops REPLACE, which is exactly where housekeeping goes missing.
    const allot = await VenueRoomAllotment.create({
      venue: venue._id, booking: booking._id, room: r2._id,
      guestName: "A Guest", checkInAt: IN, checkOutAt: OUT, status: "checked_in",
    });
    await VenueRoomNight.create({ venue: venue._id, room: r2._id, night: new Date("2036-07-10T00:00:00Z"), booking: booking._id, allotment: allot._id });
    await VenueRoomNight.create({ venue: venue._id, room: r3._id, night: new Date("2036-07-10T00:00:00Z"), booking: booking._id, allotment: null });
    await set(r2._id, "dirty");
    await set(r3._id, "clean");
    await set(r4._id, "dirty");
    const v2 = await Venue.findById(venue._id);
    v2.rooms.id(r4._id).isActive = false;
    await v2.save();

    const map = await roomStatusOn(await fresh(), DAY);
    eq(map.get(String(r2._id)).status, "occupied", "r2 is occupied");
    eq(map.get(String(r2._id)).housekeeping, "dirty", "🔴 …AND dirty — a guest in an unserviced room");
    eq(map.get(String(r2._id)).guestName, "A Guest", "…without losing the guest's name");
    eq(map.get(String(r3._id)).status, "held", "r3 is held");
    eq(map.get(String(r3._id)).housekeeping, "clean", "🔴 …AND clean — promised, and ready for them");
    eq(map.get(String(r4._id)).status, "inactive", "r4 is deactivated");
    eq(map.get(String(r4._id)).housekeeping, "dirty", "🔴 …AND still carries its last known state");
    eq(map.get(String(r1._id)).housekeeping, "inspected", "r1 is free and inspected");

    console.log("\n[the legend counts them separately, and deliberately does not add up]");
    const totals = statusTotals(map);
    eq(totals.free, 1, "1 free");
    eq(totals.occupied, 1, "1 occupied");
    eq(totals.held, 1, "1 held");
    eq(totals.inactive, 1, "1 deactivated");
    eq(totals.housekeeping.dirty, 2, "…and 2 dirty, which is a DIFFERENT question");
    eq(totals.housekeeping.clean, 1, "1 clean");
    eq(totals.housekeeping.inspected, 1, "1 inspected");
    eq(totals.housekeeping.untracked, 0, "none untracked");
    ok(totals.free + totals.occupied + totals.held + totals.inactive === 4,
      "occupancy adds to the room count");
    ok(totals.housekeeping.dirty + totals.housekeeping.clean + totals.housekeeping.inspected === 4,
      "…and so does housekeeping, separately — two axes over the same four rooms");

    console.log("\n[checking out sets the room dirty — the one automatic transition]");
    await set(r2._id, "inspected"); // pretend it was inspected before this stay
    eq((await hkOf(r2._id)).status, "inspected", "r2 reads inspected going in");
    const co = await call(checkin.checkOutAllotment, req({
      params: { allotmentId: String(allot._id) },
      // EVERY item ticked and NO damages — the strongest version of the case.
      body: { checklist: [{ item: "TV", ok: true }, { item: "Kettle", ok: true }], damages: [], notes: "" },
    }));
    eq(co.code, 200, `check-out succeeds (${co.body && co.body.message})`);
    eq((await hkOf(r2._id)).status, "dirty",
      "🔴 the room is DIRTY — every checklist item ticked, no damages, and it still needs servicing");
    eq((await hkOf(r2._id)).ready, false, "🔴 …so it does not read as ready to sell");
    ok((await hkOf(r2._id)).byName, "…recorded against whoever checked them out");

    console.log("\n[the capability — front desk, not listing]");
    // The Front Desk bundle holds ONE capability. Gating housekeeping on
    // `listing` would ship it to everyone except the people who do it.
    const routes = require("fs").readFileSync(require.resolve("../routes/venue"), "utf8");
    const line = routes.split("\n").find((l) => l.includes("/rooms/:roomId/housekeeping"));
    ok(line && line.includes('requireCapability("rooms_checkin")'),
      `🔴 gated on rooms_checkin, not listing — "${(line || "").trim().slice(0, 90)}"`);
    ok(!line.includes('requireCapability("listing")'), "…and definitely not on listing");
  } catch (err) {
    fail += 1;
    console.error("\nFATAL", err);
  } finally {
    try {
      await VenueRoomNight.deleteMany({ venue: venue && venue._id });
      await VenueRoomAllotment.deleteMany({ venue: venue && venue._id });
      await VenueBooking.deleteMany({ venue: venue && venue._id });
      await VenueEnquiry.deleteMany({ _id: lead && lead._id });
      await VenueOwner.deleteMany({ _id: owner && owner._id });
      await Venue.deleteMany({ _id: venue && venue._id });
    } catch (e) { /* best effort */ }
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  }
})();
