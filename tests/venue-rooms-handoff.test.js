// Booking→Rooms handoff — product-map dead-end #6, "the Rooms island": the lead
// says "we need 20 rooms" and Rooms/PMS never hears about it.
// Run: node tests/venue-rooms-handoff.test.js
//
// The handoff has three parts: the requirement CROSSES the lead→booking
// boundary, the allotments read SURFACES the shortfall, and a plan endpoint
// proposes concrete free rooms across the REAL stay window. Execution still
// goes through the existing POST /allotments, so there is one creation path and
// the atomic night-claiming double-booking guard is untouched.
//
// NOTE: room blocks span the actual check-in→check-out window. There are no
// fixed-duration presets anywhere in this product (founder decision) — duration
// is computed from the window, never chosen from a list.
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueBooking = require("../models/VenueBooking");
const VenueFollowUp = require("../models/VenueFollowUp");
const VenueRoomAllotment = require("../models/VenueRoomAllotment");
const VenueRoomNight = require("../models/VenueRoomNight");

const allot = require("../controllers/venueAllotment");
const { createDraftBookingForEnquiry } = require("../controllers/venueBooking");

const TAG = `venue-rooms-${Date.now()}`;
const OWNER = new mongoose.Types.ObjectId();
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const created = { venues: [] };

const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const ownerReq = (venue, extra = {}) => ({ params: { slug: venue.slug, ...(extra.params || {}) }, query: extra.query || {}, body: extra.body || {}, venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: OWNER }, venueMember: null });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    const venue = await Venue.create({
      name: `${TAG}-v`, slug: `${TAG}-v`,
      rooms: [
        { name: "101", type: "standard", capacity: 2 },
        { name: "102", type: "standard", capacity: 2 },
        { name: "103", type: "deluxe", capacity: 3 },
        { name: "Suite 1", type: "suite", capacity: 4 },
        { name: "104", type: "standard", capacity: 2, isActive: false },
      ],
    });
    created.venues.push(venue._id);

    // A real two-night stay: check-in evening of day A, check-out morning of day C.
    const checkIn = new Date("2027-02-10T16:00:00Z");
    const checkOut = new Date("2027-02-12T06:00:00Z");
    const lead = await VenueEnquiry.create({
      venueId: venue._id,
      coupleName: `${TAG} Sharma`,
      couplePhone: "9000501",
      stage: "negotiating",
      checkIn,
      checkOut,
      guestCount: 300,
      requirements: { roomsNeeded: 3, food: "both" },
    });

    // ── the requirement crosses the lead→booking boundary ──
    console.log("\n[requirement survives the lead→booking graduation]");
    const booking = await createDraftBookingForEnquiry(venue._id, lead, OWNER);
    ok(booking.roomsRequired === 3, "THE FIX: the booking inherits roomsNeeded from the lead (was: dropped on the floor)");

    const list1 = await call(allot.listAllotments, ownerReq(venue, { params: { bookingId: String(booking._id) } }));
    ok(list1.code === 200, "allotments read → 200");
    ok(list1.body.requirement, "the allotments read now answers 'what did the couple ask for?'");
    ok(list1.body.requirement.roomsNeeded === 3, "…roomsNeeded surfaced");
    ok(list1.body.requirement.allotted === 0 && list1.body.requirement.shortfall === 3, "…with a real shortfall, not a silent zero");
    ok(String(list1.body.requirement.leadId) === String(lead._id), "…and links BACK to the originating lead (the Loop Law)");

    // ── the window is the real event window, not a preset ──
    console.log("\n[window = the actual check-in→check-out span]");
    const w = list1.body.requirement.window;
    ok(new Date(w.from).getTime() === checkIn.getTime(), "window starts at the lead's real check-in");
    ok(new Date(w.to).getTime() === checkOut.getTime(), "window ends at the lead's real check-out");
    ok(w.nights === 2, "nights are computed from the window (10th, 11th), never from a duration preset");

    // ── the plan ──
    console.log("\n[plan: concrete free rooms covering the shortfall]");
    const plan1 = await call(allot.planAllotments, ownerReq(venue, { params: { bookingId: String(booking._id) } }));
    ok(plan1.code === 200, "plan → 200");
    ok(plan1.body.plan.length === 3, "proposes exactly the shortfall (3 rooms)");
    ok(plan1.body.unavailable === 0, "nothing unavailable");
    ok(plan1.body.plan.every((p) => new Date(p.checkInAt).getTime() === checkIn.getTime() && new Date(p.checkOutAt).getTime() === checkOut.getTime()),
      "every proposed block spans the actual window dates");
    ok(!plan1.body.plan.some((p) => p.roomName === "104"), "an INACTIVE room is never proposed");
    ok(plan1.body.plan.map((p) => p.roomName).join(",") === "101,102,103", "smallest suitable rooms first — a 3-room block does not eat the suite");
    ok(plan1.body.plan.every((p) => p.guestName && p.guestName.includes("Sharma")), "each block is pre-labelled with the couple");

    // ── execution goes through the EXISTING creation path ──
    console.log("\n[execute through the existing POST /allotments — one creation path]");
    const exec = await call(allot.createAllotments, ownerReq(venue, { params: { bookingId: String(booking._id) }, body: { allotments: plan1.body.plan } }));
    ok(exec.code === 201 && exec.body.allotments.length === 3, "the plan posts back cleanly to the existing endpoint");
    ok((await VenueRoomNight.countDocuments({ venue: venue._id })) === 6, "3 rooms × 2 nights = 6 night-locks claimed");

    const list2 = await call(allot.listAllotments, ownerReq(venue, { params: { bookingId: String(booking._id) } }));
    ok(list2.body.requirement.allotted === 3 && list2.body.requirement.shortfall === 0, "the shortfall closes once the rooms are blocked");
    const plan2 = await call(allot.planAllotments, ownerReq(venue, { params: { bookingId: String(booking._id) } }));
    ok(plan2.body.plan.length === 0, "planning again proposes nothing — the requirement is covered");

    // ── the double-booking guard is untouched ──
    console.log("\n[double-booking guard intact]");
    const lead2 = await VenueEnquiry.create({
      venueId: venue._id, coupleName: `${TAG} Iyer`, couplePhone: "9000502", stage: "negotiating",
      checkIn, checkOut, requirements: { roomsNeeded: 3 },
    });
    const booking2 = await createDraftBookingForEnquiry(venue._id, lead2, OWNER);
    const plan3 = await call(allot.planAllotments, ownerReq(venue, { params: { bookingId: String(booking2._id) } }));
    ok(plan3.body.plan.length === 1 && plan3.body.plan[0].roomName === "Suite 1", "a second booking on the same nights is only offered the ONE genuinely free room");
    ok(plan3.body.unavailable === 2, "…and is HONEST that 2 of the 3 requested rooms cannot be covered");

    const clash = await call(allot.createAllotments, ownerReq(venue, {
      params: { bookingId: String(booking2._id) },
      body: { allotments: [{ room: String(venue.rooms[0]._id), guestName: "Clash", checkInAt: checkIn.toISOString(), checkOutAt: checkOut.toISOString() }] },
    }));
    ok(clash.code === 409, "forcing an already-claimed room still 409s — the atomic night guard is untouched");

    // ── live lead edits reach the PMS ──
    console.log("\n[a later change to the requirement still reaches Rooms]");
    await VenueEnquiry.updateOne({ _id: lead._id }, { $set: { "requirements.roomsNeeded": 5 } });
    const list3 = await call(allot.listAllotments, ownerReq(venue, { params: { bookingId: String(booking._id) } }));
    ok(list3.body.requirement.roomsNeeded === 5, "the live lead value wins over the booking snapshot");
    ok(list3.body.requirement.shortfall === 2, "…so the shortfall reopens");

    // ── graceful edges ──
    console.log("\n[edges]");
    const noRoomsLead = await VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} NoRooms`, stage: "negotiating", eventDate: new Date("2027-03-01T00:00:00Z") });
    const b3 = await createDraftBookingForEnquiry(venue._id, noRoomsLead, OWNER);
    const list4 = await call(allot.listAllotments, ownerReq(venue, { params: { bookingId: String(b3._id) } }));
    ok(list4.body.requirement.roomsNeeded === 0 && list4.body.requirement.shortfall === 0, "a lead that needs no rooms shows a clean zero, not a prompt");
    const plan4 = await call(allot.planAllotments, ownerReq(venue, { params: { bookingId: String(b3._id) } }));
    ok(plan4.code === 200 && plan4.body.plan.length === 0, "planning a no-rooms booking is a no-op, not an error");

    const datelessLead = await VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} Dateless`, stage: "new", requirements: { roomsNeeded: 2 } });
    const b4 = await createDraftBookingForEnquiry(venue._id, datelessLead, OWNER);
    const plan5 = await call(allot.planAllotments, ownerReq(venue, { params: { bookingId: String(b4._id) } }));
    ok(plan5.code === 409, "a booking with no event dates 409s rather than inventing a window");
    ok(plan5.body.requirement.roomsNeeded === 2, "…and still reports what was asked for, so the owner knows what to fix");

    ok((await call(allot.planAllotments, ownerReq(venue, { params: { bookingId: String(new mongoose.Types.ObjectId()) } }))).code === 404, "unknown booking → 404");
    ok((await call(allot.listAllotments, ownerReq(venue, { params: { bookingId: String(new mongoose.Types.ObjectId()) } }))).code === 404, "unknown booking on the read → 404");

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error("FATAL", err);
    fail++;
  } finally {
    for (const v of created.venues) {
      const leads = await VenueEnquiry.find({ venueId: v }).select("_id").lean();
      await VenueFollowUp.deleteMany({ lead: { $in: leads.map((l) => l._id) } });
      await VenueRoomNight.deleteMany({ venue: v });
      await VenueRoomAllotment.deleteMany({ venue: v });
      await VenueBooking.deleteMany({ venue: v });
      await VenueEnquiry.deleteMany({ venueId: v });
      await Venue.deleteOne({ _id: v });
    }
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
