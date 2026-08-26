// ROOMS 6 slice 2 — a room out for repairs leaves availability WITHOUT being
// deactivated.
//
// 🔴 THE HARD PART, which this suite exists for: rooms are reserved as a COUNT
// (ROOMS 1), so taking one out of order across dates that already have held
// nights means the resort has promised more rooms than it has. It must warn,
// NAME the bookings, and let the owner proceed deliberately — and it must never
// silently orphan a held night.
//
// The assertions that matter are the negative-space ones: that it does NOT
// affect dates outside the window, does NOT warn about holds outside it, and
// does NOT release holds the owner was never warned about.
//
// Run: node tests/venue-out-of-order.test.js
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueOwner = require("../models/VenueOwner");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueBooking = require("../models/VenueBooking");
const VenueRoomNight = require("../models/VenueRoomNight");
const VenueRoomAllotment = require("../models/VenueRoomAllotment");
const roomBlocks = require("../controllers/venueRoomBlocks");
const { reserveRoomNights, bookableRooms } = require("../utils/venueRoomNights");
const { roomStatusOn, statusTotals } = require("../utils/venueRoomStatus");
const { resolveOutOfOrder, isOutOfOrderOn, hasExpired, describeOutOfOrder } = require("../utils/venueOutOfOrder");

const TAG = `ooo-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (a, b, label) => ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, req) => { const r = mockRes(); await fn(req, r); return r; };
const D = (s) => new Date(`${s}T00:00:00Z`);

let seq = 0;
const made = [];
async function fixture({ rooms = 4 } = {}) {
  seq += 1;
  const slug = `${TAG}-${seq}`;
  const venue = await Venue.create({
    name: slug, slug, city: "Bangalore", state: "Karnataka",
    rooms: Array.from({ length: rooms }, (_, i) => ({ name: `10${i + 1}`, isActive: true })),
  });
  const owner = await VenueOwner.create({ venueId: venue._id, name: "Owner", phone: `${TAG}${seq}`.slice(0, 14), isActive: true });
  const lead = await VenueEnquiry.create({
    venueId: venue._id, coupleName: "Priya & Arjun", coupleNameManual: true,
    couplePhone: String(9700000000 + seq), stage: "booked",
  });
  const booking = await VenueBooking.create({ venue: venue._id, enquiry: lead._id, coupleName: "Priya & Arjun", totalValue: 100000 });
  made.push({ venue, lead, owner });
  return { venue, owner, lead, booking };
}
const req = (f, extra = {}) => ({
  params: { slug: f.venue.slug, ...(extra.params || {}) },
  query: extra.query || {}, body: extra.body || {},
  venueOwner: { type: "venue_owner", venueId: f.venue._id, venueOwnerId: f.owner._id },
  venueMember: null,
});
const setOOO = (f, roomId, body, query) => call(roomBlocks.setOutOfOrder, req(f, { params: { roomId: String(roomId) }, body, query }));

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    console.log("\n[the window, and its edges]");
    {
      const f = await fixture();
      const r = await setOOO(f, f.venue.rooms[0]._id, { reason: "Broken AC", from: "2036-09-10", to: "2036-09-12" });
      eq(r.code, 200, "set");
      const v = await Venue.findById(f.venue._id).lean();
      const room = v.rooms[0];
      eq(isOutOfOrderOn(room, D("2036-09-09")), false, "the day before: in order");
      eq(isOutOfOrderOn(room, D("2036-09-10")), true, "the 10th: out");
      eq(isOutOfOrderOn(room, D("2036-09-11")), true, "the 11th: out");
      eq(isOutOfOrderOn(room, D("2036-09-12")), false, "🔴 the 12th: back in service — `to` is exclusive, like every window here");
      eq(describeOutOfOrder(room), "Out of order 10 Sept 2036 – 11 Sept 2036 — Broken AC",
        "…and it reads as the nights it actually covers, not 'until the 12th'");
      eq(resolveOutOfOrder(room).byName, "Owner", "…recorded against whoever did it");
    }

    console.log("\n[it leaves availability for those dates — and only those]");
    {
      const f = await fixture({ rooms: 4 });
      await setOOO(f, f.venue.rooms[0]._id, { reason: "Broken AC", from: "2036-09-10", to: "2036-09-12" });
      const v = await Venue.findById(f.venue._id).lean();
      const inside = bookableRooms(v, [D("2036-09-10"), D("2036-09-11")]);
      eq(inside.length, 3, "🔴 3 of 4 rooms are bookable inside the window");
      const outside = bookableRooms(v, [D("2036-09-20"), D("2036-09-21")]);
      eq(outside.length, 4, "🔴 all 4 outside it — the room is not gone, only unavailable then");
      const straddling = bookableRooms(v, [D("2036-09-11"), D("2036-09-12")]);
      eq(straddling.length, 3, "…and a stay that TOUCHES the window cannot use it either — a guest cannot be moved out for one night");

      // and the real reservation path agrees
      const r = await reserveRoomNights({
        venue: v, booking: f.booking, needed: 4, checkIn: D("2036-09-10"), checkOut: D("2036-09-12"),
      });
      eq(r.ok, false, "🔴 reserving all 4 inside the window is refused");
      eq(r.code, "rooms_short", "…as short inventory, through the machinery that already exists");
      eq(r.available, 3, "…naming 3 available");
    }

    console.log("\n[🔴 the collision — dates that already have held nights]");
    {
      const f = await fixture({ rooms: 4 });
      const v0 = await Venue.findById(f.venue._id);
      await reserveRoomNights({ venue: v0, booking: f.booking, needed: 4, checkIn: D("2036-09-10"), checkOut: D("2036-09-12") });
      eq(await VenueRoomNight.countDocuments({ booking: f.booking._id }), 8, "4 rooms × 2 nights are held");

      const refused = await setOOO(f, f.venue.rooms[0]._id, { reason: "Broken AC", from: "2036-09-10", to: "2036-09-12" });
      eq(refused.code, 409, "refused");
      eq(refused.body.code, "room_has_held_nights", "…with a code");
      ok(/Priya & Arjun/.test(refused.body.message), `…naming the couple: "${refused.body.message}"`);
      eq(refused.body.upcoming, 2, "…and how many nights");
      const stillIn = await Venue.findById(f.venue._id).lean();
      eq(resolveOutOfOrder(stillIn.rooms[0]), null, "🔴 and NOTHING was written — the room is still in order");
      eq(await VenueRoomNight.countDocuments({ booking: f.booking._id }), 8, "🔴 …with every held night intact");
    }

    console.log("\n[…scoped to the WINDOW, not to every hold the room has]");
    {
      const f = await fixture({ rooms: 4 });
      const v0 = await Venue.findById(f.venue._id);
      await reserveRoomNights({ venue: v0, booking: f.booking, needed: 4, checkIn: D("2036-09-10"), checkOut: D("2036-09-12") });
      // Out of order in a DIFFERENT month. The holds exist, but not here.
      const r = await setOOO(f, f.venue.rooms[0]._id, { reason: "Repaint", from: "2036-11-01", to: "2036-11-05" });
      eq(r.code, 200, "🔴 no warning — the holds are outside the window");
      eq(await VenueRoomNight.countDocuments({ booking: f.booking._id }), 8,
        "🔴 …and nothing was released. Warning about holds it does not touch is how an owner learns to click through");
    }

    console.log("\n[proceeding deliberately releases the window's holds, and only those]");
    {
      const f = await fixture({ rooms: 4 });
      const v0 = await Venue.findById(f.venue._id);
      // Two separate stays on the same room: one inside the repair window, one after.
      await reserveRoomNights({ venue: v0, booking: f.booking, needed: 4, checkIn: D("2036-09-10"), checkOut: D("2036-09-12") });
      const laterLead = await VenueEnquiry.create({
        venueId: f.venue._id, coupleName: "Later Couple", coupleNameManual: true,
        couplePhone: "9711111111", stage: "booked",
      });
      made.push({ venue: f.venue, lead: laterLead, owner: f.owner });
      const later = await VenueBooking.create({ venue: f.venue._id, enquiry: laterLead._id, coupleName: "Later Couple", totalValue: 50000 });
      await VenueRoomNight.create({ venue: f.venue._id, room: f.venue.rooms[0]._id, night: D("2036-09-20"), booking: later._id, allotment: null });
      eq(await VenueRoomNight.countDocuments({ room: f.venue.rooms[0]._id }), 3, "room 101 holds 2 nights inside + 1 after");

      const r = await setOOO(f, f.venue.rooms[0]._id, { reason: "Broken AC", from: "2036-09-10", to: "2036-09-12" }, { force: "1" });
      eq(r.code, 200, "forced through");
      eq(r.body.releasedNights.released, 2, "🔴 the 2 nights INSIDE the window were released");
      eq(await VenueRoomNight.countDocuments({ room: f.venue.rooms[0]._id, night: D("2036-09-20") }), 1,
        "🔴 …and the stay AFTER it was left completely alone");
      const v = await Venue.findById(f.venue._id).lean();
      eq(resolveOutOfOrder(v.rooms[0]).reason, "Broken AC", "…and the room is now out of order");
    }

    console.log("\n[a guest already in the room is not thrown out]");
    {
      const f = await fixture({ rooms: 4 });
      const allot = await VenueRoomAllotment.create({
        venue: f.venue._id, booking: f.booking._id, room: f.venue.rooms[0]._id,
        guestName: "A Guest", checkInAt: D("2036-09-10"), checkOutAt: D("2036-09-12"), status: "checked_in",
      });
      await VenueRoomNight.create({ venue: f.venue._id, room: f.venue.rooms[0]._id, night: D("2036-09-10"), booking: f.booking._id, allotment: allot._id });
      const r = await setOOO(f, f.venue.rooms[0]._id, { reason: "Broken AC", from: "2036-09-10", to: "2036-09-12" }, { force: "1" });
      eq(r.code, 200, "forced");
      eq(r.body.releasedNights.released, 0, "no pure holds to release");
      eq(r.body.releasedNights.keptWithAllotment, 1, "🔴 the guest's night was KEPT, and reported");
      eq(await VenueRoomNight.countDocuments({ allotment: allot._id }), 1, "🔴 …the allotment is intact");
    }

    console.log("\n[what it refuses to accept]");
    {
      const f = await fixture();
      const id = String(f.venue.rooms[0]._id);
      eq((await setOOO(f, id, { from: "2036-09-10", to: "2036-09-12" })).code, 400, "no reason → refused");
      eq((await setOOO(f, id, { reason: "x", from: "2036-09-12", to: "2036-09-10" })).code, 400, "end before start → refused");
      eq((await setOOO(f, id, { reason: "x", from: "2036-09-10", to: "2036-09-10" })).code, 400, "zero-length window → refused");
      eq((await setOOO(f, id, { reason: "x" })).code, 400, "no dates → refused");
    }

    console.log("\n[on the layout]");
    {
      const f = await fixture({ rooms: 3 });
      await setOOO(f, f.venue.rooms[0]._id, { reason: "Broken AC", from: "2036-09-10", to: "2036-09-12" });
      const v = await Venue.findById(f.venue._id).lean();
      const during = await roomStatusOn(v, D("2036-09-11"));
      eq(during.get(String(f.venue.rooms[0]._id)).status, "out_of_order", "reads out_of_order during");
      ok(/Broken AC/.test(during.get(String(f.venue.rooms[0]._id)).outOfOrder), "…with the reason on it");
      eq(statusTotals(during).out_of_order, 1, "…and counted");
      const after = await roomStatusOn(v, D("2036-09-20"));
      eq(after.get(String(f.venue.rooms[0]._id)).status, "free", "🔴 and FREE outside the window, with no action needed");
      eq(after.get(String(f.venue.rooms[0]._id)).outOfOrder, undefined, "…with no chip marking, because it is usable that day");
      ok(after.get(String(f.venue.rooms[0]._id)).outOfOrderWindow,
        "🔴 …but the WINDOW is still reported, or an owner viewing today could never see or clear a repair booked for September");
      eq(hasExpired(v.rooms[0], D("2036-09-20")), true, "…because the window expires by itself");

      // deactivation still wins — it is the more permanent truth
      const v2 = await Venue.findById(f.venue._id);
      v2.rooms[0].isActive = false;
      await v2.save();
      const both = await roomStatusOn(await Venue.findById(f.venue._id).lean(), D("2036-09-11"));
      eq(both.get(String(f.venue.rooms[0]._id)).status, "inactive",
        "🔴 a deactivated room reads inactive, not out_of_order — 'back Friday' about a removed room is worse");
    }

    console.log("\n[clearing it]");
    {
      const f = await fixture();
      await setOOO(f, f.venue.rooms[0]._id, { reason: "Broken AC", from: "2036-09-10", to: "2036-09-12" });
      const r = await call(roomBlocks.clearOutOfOrder, req(f, { params: { roomId: String(f.venue.rooms[0]._id) } }));
      eq(r.code, 200, "cleared");
      const v = await Venue.findById(f.venue._id).lean();
      eq(resolveOutOfOrder(v.rooms[0]), null, "…and the room is in order again");
      eq(bookableRooms(v, [D("2036-09-10")]).length, 4, "…and bookable on the dates it was out");
    }

    console.log("\n[a room that was never out of order is untouched — no migration]");
    {
      const f = await fixture();
      const v = await Venue.findById(f.venue._id).lean();
      eq(v.rooms[1].outOfOrder, undefined, "🔴 stores NOTHING");
      eq(resolveOutOfOrder(v.rooms[1]), null, "…resolves to null");
      const m = await roomStatusOn(v, new Date());
      eq(m.get(String(f.venue.rooms[1]._id)).status, "free", "…and reads exactly as it does today");
      eq(m.get(String(f.venue.rooms[1]._id)).outOfOrder, undefined, "…with no out-of-order field at all");
    }

    console.log("\n[the response shape — same surface, same payload]");
    {
      const f = await fixture();
      const w = await setOOO(f, f.venue.rooms[0]._id, { reason: "x", from: "2036-09-10", to: "2036-09-12" });
      const readBack = await call(roomBlocks.getLayout, req(f, { query: { withStatus: "1" } }));
      const missing = Object.keys(readBack.body).filter((k) => !(k in w.body));
      eq(missing.join(",") || "(none)", "(none)",
        "🔴 the write carries every key the read endpoint returns — the ROOMS 3 defect, checked rather than assumed");
    }
  } catch (err) {
    fail += 1;
    console.error("\nFATAL", err);
  } finally {
    try {
      for (const { venue, lead, owner } of made) {
        await VenueRoomNight.deleteMany({ venue: venue._id });
        await VenueRoomAllotment.deleteMany({ venue: venue._id });
        await VenueBooking.deleteMany({ venue: venue._id });
        await VenueEnquiry.deleteMany({ _id: lead._id });
        await VenueOwner.deleteMany({ _id: owner._id });
        await Venue.deleteMany({ _id: venue._id });
      }
    } catch (e) { /* best effort */ }
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  }
})();
