// A booking-keyed read is still a LEAD read.
// Run: node tests/venue-booking-scope.test.js
//
// Room allotments and the runsheet are keyed by booking id, and both
// controllers resolved nothing but the VENUE — so a member who cannot see a
// lead could read and write its room plan and its per-day runsheet (guest
// names, room numbers, the whole event schedule) by knowing a booking id.
//
// This is the deny sweep BY DIRECT ID, with the write-didn't-happen assertion,
// across BOTH shapes:
//   · booking-keyed  /bookings/:bookingId/allotments, /runsheet
//   · item-keyed     /allotments/:allotmentId, /runsheet/:itemId
//
// The item-keyed routes are not a different kind of surface: the row carries
// `booking`, the booking carries `enquiry`, so the same lead is one hop away
// and the same member reaches the same guest names by holding an item id.
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueOwner = require("../models/VenueOwner");
const VenueTeamMember = require("../models/VenueTeamMember");
const VenueRole = require("../models/VenueRole");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueBooking = require("../models/VenueBooking");
const VenueRoomAllotment = require("../models/VenueRoomAllotment");
const VenueRunsheetItem = require("../models/VenueRunsheetItem");

const allot = require("../controllers/venueAllotment");
const runsheet = require("../controllers/venueRunsheetCtl");
const checkin = require("../controllers/venueCheckin");

const TAG = `bscope-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const created = { venues: [], owners: [] };
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    const venue = await Venue.create({
      name: `${TAG} Palace`, slug: `${TAG}-v`, city: "Bangalore", state: "Karnataka",
      rooms: [
        { name: "Rose", capacity: 2, isActive: true },
        { name: "Lily", capacity: 2, isActive: true },
      ],
      spaces: [{ name: "Lawn", isBookable: true }],
    });
    created.venues.push(venue._id);
    const owner = await VenueOwner.create({ venueId: venue._id, name: "Owner", phone: `${TAG}o`, isActive: true });
    created.owners.push(owner._id);

    // A SCOPED member: sees only their own leads (no leads_view_all).
    const role = await VenueRole.create({ venue: venue._id, name: "Sales", capabilities: ["leads", "rooms_checkin"] });
    const member = await VenueTeamMember.create({
      venueId: venue._id, name: "Scoped Sales", phone: `${TAG}m`, role: "sales", roleRef: role._id, isActive: true,
    });

    // A lead that is NOT theirs, with a booking, an allotment and a runsheet item.
    const theirs = await VenueEnquiry.create({
      venueId: venue._id, coupleName: "Someone Else", coupleNameManual: true,
      couplePhone: "9800002222", stage: "booked",
    });
    const booking = await VenueBooking.create({
      venue: venue._id, enquiry: theirs._id, coupleName: "Someone Else", totalValue: 500000,
      days: [{ date: new Date("2027-05-01T00:00:00Z"), guestCount: 100 }],
      roomsRequired: 2,
    });
    const allotment = await VenueRoomAllotment.create({
      venue: venue._id, booking: booking._id, room: venue.rooms[0]._id, roomName: "Rose",
      guestName: "Aunt Meera",
      checkInAt: new Date("2027-05-01T00:00:00Z"), checkOutAt: new Date("2027-05-02T00:00:00Z"),
      status: "allotted",
    });
    const item = await VenueRunsheetItem.create({
      venue: venue._id, booking: booking._id, day: "2027-05-01",
      title: "Mandap setup", time: "08:00", order: 1,
    });

    // The member's request shape — a real scoped member, not an owner token.
    const asMember = (extra = {}) => ({
      params: { slug: venue.slug, bookingId: String(booking._id), ...(extra.params || {}) },
      query: extra.query || {}, body: extra.body || {},
      venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: owner._id, memberId: member._id },
      venueMember: member,
    });

    console.log("\n[1. booking-keyed: a scoped member cannot reach another lead's booking]");
    const bookingKeyed = [
      ["GET  allotments", allot.listAllotments, {}],
      ["POST allotments", allot.createAllotments, { body: { allotments: [{ room: String(venue.rooms[1]._id), guestName: "X", from: "2027-05-01", to: "2027-05-02" }] } }],
      ["GET  allotments/plan", allot.planAllotments, {}],
      ["GET  runsheet", runsheet.listRunsheet, {}],
      ["POST runsheet", runsheet.createItem, { body: { day: "2027-05-01", title: "Sneaky", time: "09:00" } }],
      ["POST runsheet/reorder", runsheet.reorderRunsheet, { body: { day: "2027-05-01", order: [String(item._id)] } }],
    ];
    for (const [name, fn, extra] of bookingKeyed) {
      const r = await call(fn, asMember(extra));
      ok(r.code === 404, `${name.padEnd(22)} → 404 (got ${r.code})`);
      ok(r.code !== 403, `${" ".padEnd(22)}   …404 not 403 — a miss must not confirm the booking exists`);
    }

    console.log("\n[2. item-keyed: the same lead is one hop away, and just as closed]");
    const itemKeyed = [
      ["PATCH allotment", allot.updateAllotment, { params: { allotmentId: String(allotment._id) }, body: { notes: "hi" } }],
      ["POST  check-in", checkin.checkInAllotment, { params: { allotmentId: String(allotment._id) }, body: {} }],
      ["PATCH runsheet item", runsheet.updateItem, { params: { itemId: String(item._id) }, body: { title: "Renamed" } }],
      ["DELETE runsheet item", runsheet.deleteItem, { params: { itemId: String(item._id) } }],
    ];
    for (const [name, fn, extra] of itemKeyed) {
      if (typeof fn !== "function") { ok(false, `${name} — handler not exported, cannot test`); continue; }
      const r = await call(fn, asMember(extra));
      ok(r.code === 404, `${name.padEnd(22)} → 404 (got ${r.code})`);
    }

    console.log("\n[3. THE WRITE DIDN'T HAPPEN]");
    const allotmentsNow = await VenueRoomAllotment.countDocuments({ booking: booking._id });
    ok(allotmentsNow === 1, `still exactly the ONE allotment that existed before (got ${allotmentsNow})`);
    const freshAllot = await VenueRoomAllotment.findById(allotment._id).lean();
    ok(freshAllot.guestName === "Aunt Meera", "…with its guest name untouched");
    ok(!freshAllot.notes, "…and no note written by the refused PATCH");
    ok(freshAllot.status === "allotted", "…and its status unchanged — no check-in landed");
    const itemsNow = await VenueRunsheetItem.countDocuments({ booking: booking._id });
    ok(itemsNow === 1, `still exactly the ONE runsheet item (got ${itemsNow})`);
    const freshItem = await VenueRunsheetItem.findById(item._id).lean();
    ok(freshItem && freshItem.title === "Mandap setup", "…with its title unchanged, and NOT deleted");

    console.log("\n[4. the same member CAN reach a lead that is theirs]");
    const mine = await VenueEnquiry.create({
      venueId: venue._id, coupleName: "My Couple", coupleNameManual: true,
      couplePhone: "9800003333", stage: "booked", assignedTo: member._id,
    });
    const myBooking = await VenueBooking.create({
      venue: venue._id, enquiry: mine._id, coupleName: "My Couple", totalValue: 100000,
      days: [{ date: new Date("2027-06-01T00:00:00Z"), guestCount: 50 }],
    });
    const mineReq = { ...asMember(), params: { slug: venue.slug, bookingId: String(myBooking._id) } };
    const mineList = await call(allot.listAllotments, mineReq);
    ok(mineList.code === 200, `their own booking's allotments read → 200 (got ${mineList.code})`);
    const mineRun = await call(runsheet.listRunsheet, mineReq);
    ok(mineRun.code === 200, "…and its runsheet too — the guard scopes, it does not simply deny");

    console.log("\n[5. the owner is unaffected]");
    const asOwner = {
      params: { slug: venue.slug, bookingId: String(booking._id) },
      query: {}, body: {},
      venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: owner._id },
      venueMember: null,
    };
    ok((await call(allot.listAllotments, asOwner)).code === 200, "an owner still reads any booking's allotments");
    ok((await call(runsheet.listRunsheet, asOwner)).code === 200, "…and any booking's runsheet");

    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error("FATAL", e);
    fail++;
  } finally {
    for (const v of created.venues) {
      await VenueRunsheetItem.deleteMany({ venue: v });
      await VenueRoomAllotment.deleteMany({ venue: v });
      await VenueBooking.deleteMany({ venue: v });
      await VenueEnquiry.deleteMany({ venueId: v });
      await VenueTeamMember.deleteMany({ venueId: v });
      await VenueRole.deleteMany({ venue: v });
      await Venue.deleteOne({ _id: v });
    }
    await VenueOwner.deleteMany({ _id: { $in: created.owners } });
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
