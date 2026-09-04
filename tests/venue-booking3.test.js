// BOOKING 3 — rooms as a record, the overlap warning.
// Run: DATABASE_URL=... node tests/venue-booking3.test.js
//
// Founder ruling under test: one event at a time; rooms come WITH the event.
// The rooms step RECORDS how many of each category the couple gets — no
// availability question, no hold, no refusal beyond arithmetic (a count may
// not exceed the category's ceiling). The overlap check WARNS, never blocks,
// at TIME level, confirmed bookings only.
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueBooking = require("../models/VenueBooking");
const VenueSpaceDate = require("../models/VenueSpaceDate");

const bookings = require("../controllers/venueBooking");
const { roomCategories, checkRoomsAllocation } = require("../utils/venueRoomCategories");
const { buildVenueDocument } = require("../utils/docsystem");
const { pdfFlat } = require("./docsystem-helpers");

const TAG = `bk3-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, r) => { const res = mockRes(); await fn(r, res); return res; };
const created = { venues: [] };

let venue, lawnId;
const req = (extra = {}) => ({
  params: { slug: venue.slug, ...(extra.params || {}) },
  query: extra.query || {}, body: extra.body || {},
  venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: new mongoose.Types.ObjectId() },
  venueMember: null,
});
const mkLead = (extra = {}) => VenueEnquiry.create({
  venueId: venue._id, coupleName: `${TAG} ${Math.random().toString(36).slice(2, 6)}`,
  couplePhone: `9${Math.floor(Math.random() * 1e9)}`, stage: "negotiating", activities: [], ...extra,
});
const confirmBody = (date, extras = {}) => ({
  functions: [{ date, space: lawnId, name: "Reception", pax: 200 }],
  tokenAmount: 100000, tokenMode: "UPI",
  paymentSchedule: [{ label: "Balance", amount: 400000, dueDate: "2027-05-01" }],
  ...extras,
});

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    await VenueSpaceDate.init(); // fresh-DB unique-index race (venue-crm-s2 lesson)
    const deluxe = new mongoose.Types.ObjectId();
    const suite = new mongoose.Types.ObjectId();
    venue = await Venue.create({
      name: `${TAG} Resort`, slug: `${TAG}-v`,
      spaces: [{ name: "Lawn", isBookable: true }],
      roomTypes: [{ _id: deluxe, name: "Deluxe" }, { _id: suite, name: "Lake Suite" }],
      rooms: [
        ...Array.from({ length: 6 }, (_, i) => ({ name: `D${i + 1}`, typeRef: deluxe })),
        ...Array.from({ length: 2 }, (_, i) => ({ name: `S${i + 1}`, typeRef: suite })),
        { name: "Annex", typeRef: null },
        { name: "Store-turned-room", typeRef: deluxe, isActive: false }, // inactive: not in the ceiling
      ],
    });
    created.venues.push(venue._id);
    lawnId = String(venue.spaces[0]._id);

    // ══ 1. CATEGORIES AND THE VALIDATOR (pure) ══════════════════════════════
    console.log("\n[1. categories carry their ceilings; the only validation is arithmetic]");
    const cats = roomCategories(venue);
    eq(cats.length, 3, "three categories (two typed + untyped)");
    eq(cats.find((c) => c.name === "Deluxe").total, 6, "🔴 the inactive room is not in the ceiling");
    eq(cats.find((c) => c.name === "Lake Suite").total, 2, "suite total");
    eq(cats.find((c) => c.typeRef === null).name, "Other rooms", "untyped rooms form their own category");
    let v = checkRoomsAllocation({ mode: "all" }, venue);
    ok(v.ok && v.value.mode === "all" && v.value.items.length === 3 && v.value.items.reduce((s, i) => s + i.count, 0) === 9,
      "🔴 'all rooms' snapshots every category at its ceiling (9)");
    v = checkRoomsAllocation({ mode: "counts", counts: [{ typeRef: String(deluxe), count: 7 }] }, venue);
    ok(!v.ok && /has 6/.test(v.message) && /all rooms/.test(v.message),
      "🔴 a count above the ceiling refuses, naming the ceiling and the way out");
    v = checkRoomsAllocation({ mode: "counts", counts: [{ typeRef: String(deluxe), count: 4 }, { typeRef: String(suite), count: 2 }] }, venue);
    ok(v.ok && v.value.items.length === 2 && v.value.items[1].count === 2 && v.value.items[1].total === 2,
      "multiple categories, counts + ceilings snapshotted");
    v = checkRoomsAllocation(undefined, venue);
    ok(v.ok && v.value === null, "absent = skipped = nothing recorded");
    v = checkRoomsAllocation({ mode: "counts", counts: [{ typeRef: String(deluxe), count: 0 }] }, venue);
    ok(v.ok && v.value === null, "all zeros = nothing recorded, not a zero record");

    // ══ 2. CONFIRM STORES THE RECORD — read back from Mongo ═════════════════
    console.log("\n[2. the record on the stored booking]");
    const leadAll = await mkLead();
    let r = await call(bookings.confirmBookingFromLead, req({ params: { enquiryId: String(leadAll._id) }, body: confirmBody("2027-03-10", { roomsAllocation: { mode: "all" } }) }));
    eq(r.code, 200, `all-rooms confirm (got ${r.code}: ${r.body && r.body.message})`);
    let stored = await VenueBooking.findOne({ enquiry: leadAll._id }).lean();
    eq(stored.roomsAllocation.mode, "all", "🔴 stored mode");
    eq(stored.roomsAllocation.items.reduce((s, i) => s + i.count, 0), 9, "🔴 stored counts sum to every room");

    const leadCounts = await mkLead();
    r = await call(bookings.confirmBookingFromLead, req({ params: { enquiryId: String(leadCounts._id) }, body: confirmBody("2027-03-20", { roomsAllocation: { mode: "counts", counts: [{ typeRef: String(deluxe), count: 4 }, { typeRef: String(suite), count: 2 }] } }) }));
    eq(r.code, 200, "per-category confirm");
    stored = await VenueBooking.findOne({ enquiry: leadCounts._id }).lean();
    eq(stored.roomsAllocation.items.map((i) => `${i.name}:${i.count}/${i.total}`).join(","), "Deluxe:4/6,Lake Suite:2/2", "🔴 stored names, counts and ceilings");

    const leadOver = await mkLead();
    r = await call(bookings.confirmBookingFromLead, req({ params: { enquiryId: String(leadOver._id) }, body: confirmBody("2027-04-01", { roomsAllocation: { mode: "counts", counts: [{ typeRef: String(deluxe), count: 9 }] } }) }));
    eq(r.code, 400, "🔴 a count above the ceiling refuses the confirm");
    eq(r.body.code, "rooms_allocation_invalid", "…with the machine code");
    ok(!(await VenueBooking.findOne({ enquiry: leadOver._id, status: "confirmed" })), "…and nothing confirmed (refused before the calendar)");
    ok((await VenueSpaceDate.countDocuments({ venue: venue._id, date: "2027-04-01", state: "booked" })) === 0, "…and no calendar row survived");

    const leadSkip = await mkLead();
    r = await call(bookings.confirmBookingFromLead, req({ params: { enquiryId: String(leadSkip._id) }, body: confirmBody("2027-04-10") }));
    eq(r.code, 200, "skipping the step confirms fine");
    stored = await VenueBooking.findOne({ enquiry: leadSkip._id }).lean();
    ok(!stored.roomsAllocation, "🔴 skipped = NOTHING stored, not zero");

    // ══ 3. THE DOCUMENTS PRINT THE RECORD — and stay silent when skipped ════
    console.log("\n[3. quote + confirmation render the rooms line]");
    const bAll = await VenueBooking.findOne({ enquiry: leadCounts._id }).lean();
    const leadDoc = await VenueEnquiry.findById(leadCounts._id).lean();
    const conf = await buildVenueDocument("confirmation", { venue, lead: leadDoc, booking: bAll }, { compress: false, language: "classic" });
    const flatC = pdfFlat(conf.buffer);
    ok(flatC.includes("4 of 6 Deluxe") && flatC.includes("all 2 Lake Suite"), "🔴 confirmation prints counts against ceilings");
    const quote = { lineItems: [{ label: "Venue", amount: 500000, gstTreatment: "none" }], gstPercent: 0, version: 1, createdAt: new Date() };
    const q = await buildVenueDocument("quote", { venue, lead: leadDoc, quote, booking: bAll }, { compress: false, language: "classic" });
    ok(pdfFlat(q.buffer).includes("4 of 6 Deluxe"), "🔴 the quote's rooms-allocated line renders (it had nothing before)");
    const bSkip = await VenueBooking.findOne({ enquiry: leadSkip._id }).lean();
    const confSkip = await buildVenueDocument("confirmation", { venue, lead: await VenueEnquiry.findById(leadSkip._id).lean(), booking: bSkip }, { compress: false, language: "classic" });
    const flatSkip = pdfFlat(confSkip.buffer);
    ok(!/rooms/i.test(flatSkip.replace(/Other rooms/g, "")), "🔴 skipped → the documents say NOTHING about rooms (no zero)");
    const allBooking = await VenueBooking.findOne({ enquiry: leadAll._id }).lean();
    const confAll = await buildVenueDocument("confirmation", { venue, lead: await VenueEnquiry.findById(leadAll._id).lean(), booking: allBooking }, { compress: false, language: "classic" });
    ok(pdfFlat(confAll.buffer).includes("All rooms (9)"), "…and 'all rooms' prints as the whole property");

    // ══ 4. THE OVERLAP WARNING — time-level, warn-only, confirmed-only ══════
    console.log("\n[4. the overlap check]");
    // give the leadAll booking a concrete window: 10 Mar 10:00 → 11 Mar 14:00
    await VenueBooking.updateOne({ enquiry: leadAll._id }, { $set: { checkIn: new Date("2027-03-10T10:00:00+05:30"), checkOut: new Date("2027-03-11T14:00:00+05:30") } });
    const probe = async (checkIn, checkOut) =>
      call(bookings.overlapCheck, req({ params: { enquiryId: String(new mongoose.Types.ObjectId()) }, query: { checkIn, checkOut } }));
    let o = await probe("2027-03-11T10:00:00+05:30", "2027-03-12T10:00:00+05:30");
    eq(o.code, 200, "overlap probe answers");
    eq(o.body.overlaps.length, 1, "🔴 a check-in BEFORE the existing check-out warns");
    ok(/runs until/.test(o.body.overlaps[0].message) && /still confirm/i.test(o.body.overlaps[0].message),
      "…naming the event, its check-out, the fix — and that they can proceed");
    o = await probe("2027-03-11T14:00:00+05:30", "2027-03-12T10:00:00+05:30");
    eq(o.body.overlaps.length, 0, "🔴 a check-in EXACTLY AT the check-out is a clean same-day turnaround — no warning");
    o = await probe("2027-03-12T10:00:00+05:30", "2027-03-13T10:00:00+05:30");
    eq(o.body.overlaps.length, 0, "a check-in after is clean");
    // cancelled bookings never warn
    await VenueBooking.updateOne({ enquiry: leadAll._id }, { $set: { status: "cancelled" } });
    o = await probe("2027-03-11T10:00:00+05:30", "2027-03-12T10:00:00+05:30");
    eq(o.body.overlaps.length, 0, "🔴 CONFIRMED bookings only — a cancelled event does not warn");
    await VenueBooking.updateOne({ enquiry: leadAll._id }, { $set: { status: "confirmed" } });
    // and the check does not block: confirming an overlapping event succeeds
    const leadClash = await mkLead();
    r = await call(bookings.confirmBookingFromLead, req({ params: { enquiryId: String(leadClash._id) }, body: confirmBody("2027-03-11") }));
    eq(r.code, 200, "🔴 an overlapping confirm still goes through — a warning, never a block");

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error("SUITE CRASHED:", e);
    process.exitCode = 1;
  } finally {
    try {
      await VenueSpaceDate.deleteMany({ venue: { $in: created.venues } });
      await VenueBooking.deleteMany({ venue: { $in: created.venues } });
      await VenueEnquiry.deleteMany({ venueId: { $in: created.venues } });
      await Venue.deleteMany({ _id: { $in: created.venues } });
    } catch (_) { /* fresh test DBs are disposable */ }
    await mongoose.disconnect();
  }
})();
