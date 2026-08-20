// ONE DATE — a lead's window and its booking's window are the same thing.
// Run: node tests/venue-one-window.test.js
//
// What this has to prove, because all of it was broken or absent:
//   1. confirming a booking CARRIES the window (it used to discard it)
//   2. every day in the window blocks (it used to block only function days)
//   3. editing from the LEAD moves the booking and the calendar
//   4. editing from the BOOKING moves the lead and the calendar
//   5. a function left outside the new window is NAMED and blocks the save
//   6. a hold on a dropped day is named and needs an explicit acknowledgement
//   7. a collision REFUSES and releases nothing — including a collision that
//      lands mid-batch, which is the case that would otherwise half-apply
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueOwner = require("../models/VenueOwner");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueBooking = require("../models/VenueBooking");
const VenueSpaceDate = require("../models/VenueSpaceDate");
const VenueHold = require("../models/VenueHold");

const vb = require("../controllers/venueBooking");
const ve = require("../controllers/venueEnquiry");
const { venueDateKey } = require("../utils/venueTime");

const TAG = `ow-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const created = { venues: [], owners: [] };
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };

const iso = (s) => new Date(`${s}T00:00:00.000Z`);
/** Every venue-day currently blocked for a booking, sorted. */
const blockedDays = async (bookingId) =>
  (await VenueSpaceDate.find({ bookingRef: bookingId }).select("date space").lean())
    .map((r) => venueDateKey(r.date))
    .sort();
const distinct = (a) => [...new Set(a)].sort();

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    await VenueSpaceDate.init(); // the unique {venue,space,date} guard must exist

    const venue = await Venue.create({
      name: `${TAG} Palace`, slug: `${TAG}-v`, city: "Bangalore", state: "Karnataka",
      spaces: [
        { name: "Lawn", type: "outdoor", capacitySeated: 500, isBookable: true },
        { name: "Hall", type: "indoor", capacitySeated: 300, isBookable: true },
      ],
    });
    created.venues.push(venue._id);
    const lawn = venue.spaces[0]._id;
    const hall = venue.spaces[1]._id;
    const owner = await VenueOwner.create({ venueId: venue._id, name: "Owner", phone: `${TAG}o`, isActive: true });
    created.owners.push(owner._id);

    const ownerReq = (extra = {}) => ({
      params: { slug: venue.slug, ...(extra.params || {}) },
      query: extra.query || {},
      body: extra.body || {},
      venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: owner._id, name: "Owner" },
      venueMember: null,
    });

    // The founder's own case: window opens 29 Sept 4 PM, functions on the
    // 30th and the 1st. The 29th is inside the window and must be sold.
    const lead = await VenueEnquiry.create({
      venueId: venue._id, coupleName: "Priya & Arjun", coupleNameManual: true,
      couplePhone: "9800001111", stage: "proposal_sent", datesFinalised: true,
      checkIn: new Date("2026-09-29T10:30:00.000Z"),   // 4 PM IST
      checkOut: new Date("2026-10-01T10:30:00.000Z"),  // 4 PM IST
      functions: [
        { name: "wedding", date: iso("2026-09-30"), space: lawn, expectedPax: 300 },
        { name: "reception", date: iso("2026-10-01"), space: lawn, expectedPax: 250 },
      ],
    });

    // ══ 1 · CONFIRM CARRIES THE WINDOW ══════════════════════════════════════
    console.log("\n[1. confirming a booking carries the lead's window]");
    const confirmed = await call(vb.confirmBookingFromLead, ownerReq({
      params: { enquiryId: String(lead._id) },
      body: {
        functions: [
          { date: "2026-09-30", space: String(lawn), name: "Wedding", pax: 300 },
          { date: "2026-10-01", space: String(lawn), name: "Reception", pax: 250 },
        ],
        totalValue: 1000000,
        paymentSchedule: [{ label: "Advance", percent: 100, amount: 1000000, dueDate: "2026-09-01" }],
      },
    }));
    ok(
      confirmed.code === 200 || confirmed.code === 201,
      `confirm succeeded (got ${confirmed.code}${confirmed.code >= 300 ? " " + JSON.stringify(confirmed.body) : ""})`
    );
    const booking = await VenueBooking.findOne({ enquiry: lead._id });
    ok(Boolean(booking.checkIn && booking.checkOut), "the booking has a window at all — it used to have none");
    ok(
      String(booking.checkIn) === String(lead.checkIn) && String(booking.checkOut) === String(lead.checkOut),
      "…and it is the SAME window as the lead's, to the minute"
    );
    ok(booking.days.length === 2, "days[] still records what happens on each date (2 functions)");

    // ══ 2 · THE WHOLE WINDOW BLOCKS ═════════════════════════════════════════
    console.log("\n[2. every day in the window blocks, not just the function days]");
    const days1 = distinct(await blockedDays(booking._id));
    ok(
      days1.join(",") === "2026-09-29,2026-09-30,2026-10-01",
      `29 Sept is blocked even though no function sits on it (got ${days1.join(", ")})`
    );
    const rows1 = await VenueSpaceDate.find({ bookingRef: booking._id }).lean();
    ok(rows1.every((r) => r.state === "booked"), "…every row is state 'booked'");
    ok(rows1.every((r) => String(r.space) === String(lawn)), "…on the space the booking actually uses");

    // ══ 3 · EDIT FROM THE LEAD ══════════════════════════════════════════════
    console.log("\n[3. editing the window on the LEAD moves the booking and the calendar]");
    const fromLead = await call(ve.updateEnquiry, ownerReq({
      params: { enquiryId: String(lead._id) },
      body: {
        checkIn: "2026-09-28T10:30:00.000Z",
        checkOut: "2026-10-01T10:30:00.000Z",
      },
    }));
    ok(fromLead.code === 200, `widening the window from the lead → 200 (got ${fromLead.code}${fromLead.code !== 200 ? " " + JSON.stringify(fromLead.body).slice(0, 160) : ""})`);
    const b2 = await VenueBooking.findById(booking._id).lean();
    const l2 = await VenueEnquiry.findById(lead._id).lean();
    ok(venueDateKey(b2.checkIn) === "2026-09-28", `the BOOKING followed to 28 Sept (got ${venueDateKey(b2.checkIn)})`);
    ok(String(b2.checkIn) === String(l2.checkIn), "…and the two copies are identical");
    const days2 = distinct(await blockedDays(booking._id));
    ok(
      days2.join(",") === "2026-09-28,2026-09-29,2026-09-30,2026-10-01",
      `the calendar gained 28 Sept (got ${days2.join(", ")})`
    );

    // ══ 4 · EDIT FROM THE BOOKING ═══════════════════════════════════════════
    console.log("\n[4. editing the window on the BOOKING moves the lead and the calendar]");
    const fromBooking = await call(vb.updateBookingWindow, ownerReq({
      params: { bookingId: String(booking._id) },
      body: { checkIn: "2026-09-30T04:30:00.000Z", checkOut: "2026-10-01T10:30:00.000Z" },
    }));
    ok(fromBooking.code === 200, `shrinking from the booking → 200 (got ${fromBooking.code}${fromBooking.code !== 200 ? " " + JSON.stringify(fromBooking.body).slice(0, 200) : ""})`);
    const l3 = await VenueEnquiry.findById(lead._id).lean();
    const b3 = await VenueBooking.findById(booking._id).lean();
    ok(venueDateKey(l3.checkIn) === "2026-09-30", `the LEAD followed to 30 Sept (got ${venueDateKey(l3.checkIn)})`);
    ok(String(l3.checkIn) === String(b3.checkIn), "…and the two copies are identical");
    ok(venueDateKey(l3.eventDate) === "2026-09-30", "…and eventDate, which the rest of the platform reads, followed too");
    const days3 = distinct(await blockedDays(booking._id));
    ok(
      days3.join(",") === "2026-09-30,2026-10-01",
      `the calendar RELEASED 28 and 29 Sept (got ${days3.join(", ")})`
    );
    ok(
      (await VenueSpaceDate.countDocuments({ venue: venue._id, space: lawn, date: iso("2026-09-28") })) === 0,
      "…28 Sept is genuinely free again, not merely unlinked"
    );

    // ══ 5 · A FUNCTION LEFT OUTSIDE IS NAMED AND BLOCKS ═════════════════════
    console.log("\n[5. a function outside the new window is named, and blocks the save]");
    const before5 = distinct(await blockedDays(booking._id));
    const strand = await call(vb.updateBookingWindow, ownerReq({
      params: { bookingId: String(booking._id) },
      body: { checkIn: "2026-09-30T04:30:00.000Z", checkOut: "2026-09-30T18:00:00.000Z" },
    }));
    ok(strand.code === 409, `dropping the Reception's day → 409 (got ${strand.code})`);
    ok(strand.body.code === "functions_outside_window", "…with a machine-readable code");
    ok(
      Array.isArray(strand.body.conflictingFunctions) && strand.body.conflictingFunctions.length === 1,
      "…naming exactly the one function that would be stranded"
    );
    ok(
      /reception/i.test(JSON.stringify(strand.body.conflictingFunctions)) &&
        /2026-10-01/.test(JSON.stringify(strand.body.conflictingFunctions)),
      `…by name and date: "${strand.body.message}"`
    );
    ok(
      distinct(await blockedDays(booking._id)).join(",") === before5.join(","),
      "…and the calendar was not touched by the refused change"
    );
    const l5 = await VenueEnquiry.findById(lead._id).lean();
    ok(venueDateKey(l5.checkIn) === "2026-09-30" && venueDateKey(l5.checkOut) === "2026-10-01", "…nor was the lead's window");

    // ══ 6 · A STRANDED HOLD IS NAMED AND NEEDS ACKNOWLEDGEMENT ══════════════
    console.log("\n[6. a hold on a day the new window drops is named, never released silently]");
    const hold = await VenueHold.create({
      venue: venue._id, linkedEnquiry: lead._id, status: "approved", requestedBy: "owner",
      spaces: [hall], dates: [iso("2026-10-01")], expiresAt: new Date(Date.now() + 30 * 86400000),
    });
    const heldRow = await VenueSpaceDate.create({
      venue: venue._id, space: hall, date: iso("2026-10-01"), state: "held", holdRef: hold._id,
    });
    // Move the window off the held day. The functions move with it, so only the
    // hold is in the way.
    await VenueEnquiry.updateOne(
      { _id: lead._id },
      { $set: { "functions.1.date": iso("2026-09-30") } }
    );
    const holdRefusal = await call(vb.updateBookingWindow, ownerReq({
      params: { bookingId: String(booking._id) },
      body: { checkIn: "2026-09-30T04:30:00.000Z", checkOut: "2026-09-30T18:00:00.000Z" },
    }));
    ok(holdRefusal.code === 409 && holdRefusal.body.code === "stale_holds", `→ 409 stale_holds (got ${holdRefusal.code} ${holdRefusal.body.code || ""})`);
    ok((holdRefusal.body.staleHolds || []).length === 1, "…naming the hold");
    ok(holdRefusal.body.acknowledgeWith === "acknowledgeStaleHolds", "…and how to proceed");
    ok(
      (await VenueHold.findById(hold._id).lean()).status === "approved",
      "…the hold itself is untouched — never released for the owner"
    );
    const acked = await call(vb.updateBookingWindow, ownerReq({
      params: { bookingId: String(booking._id) },
      body: { checkIn: "2026-09-30T04:30:00.000Z", checkOut: "2026-09-30T18:00:00.000Z", acknowledgeStaleHolds: true },
    }));
    ok(acked.code === 200, `acknowledging lets it through → 200 (got ${acked.code}${acked.code !== 200 ? " " + JSON.stringify(acked.body).slice(0, 160) : ""})`);
    ok(
      (await VenueHold.findById(hold._id).lean()).status === "approved",
      "…and STILL does not release the hold — the owner does that"
    );
    await VenueSpaceDate.deleteOne({ _id: heldRow._id });
    await VenueHold.deleteOne({ _id: hold._id });

    // ══ 7 · A COLLISION MID-BATCH REFUSES AND RELEASES NOTHING ══════════════
    // The dangerous case. A move both CLAIMS new dates and RELEASES old ones,
    // and the collision is not the first row inserted — so a naive
    // implementation would have already written some rows, or worse, already
    // freed the old ones, before discovering the clash. Either outcome is a
    // date sold twice.
    console.log("\n[7. a collision partway through a move refuses, and releases nothing]");
    const leadB = await VenueEnquiry.create({
      venueId: venue._id, coupleName: "Meera & Sanjay", coupleNameManual: true,
      couplePhone: "9800002222", stage: "proposal_sent", datesFinalised: true,
      checkIn: iso("2027-03-01"), checkOut: new Date("2027-03-05T12:00:00.000Z"),
      functions: [{ name: "wedding", date: iso("2027-03-03"), space: hall, expectedPax: 200 }],
    });
    const confirmB = await call(vb.confirmBookingFromLead, ownerReq({
      params: { enquiryId: String(leadB._id) },
      body: {
        functions: [{ date: "2027-03-03", space: String(hall), name: "Wedding", pax: 200 }],
        totalValue: 500000,
        paymentSchedule: [{ label: "Advance", percent: 100, amount: 500000, dueDate: "2027-02-01" }],
      },
    }));
    ok(confirmB.code < 300, `second booking confirmed (got ${confirmB.code})`);
    const bookingB = await VenueBooking.findOne({ enquiry: leadB._id });
    const beforeB = distinct(await blockedDays(bookingB._id));
    ok(
      beforeB.join(",") === "2027-03-01,2027-03-02,2027-03-03,2027-03-04,2027-03-05",
      `it holds the whole 5-day window (got ${beforeB.join(", ")})`
    );

    // Someone else takes 7 March on the same space.
    const rival = await VenueEnquiry.create({
      venueId: venue._id, coupleName: "Rival Couple", coupleNameManual: true,
      couplePhone: "9800003333", stage: "booked",
    });
    const rivalBooking = await VenueBooking.create({
      venue: venue._id, enquiry: rival._id, coupleName: "Rival Couple", totalValue: 1,
    });
    await VenueSpaceDate.create({
      venue: venue._id, space: hall, date: iso("2027-03-07"), state: "booked", bookingRef: rivalBooking._id,
    });

    // Move 01–05 Mar → 03–07 Mar. That RELEASES 1 and 2 March and CLAIMS
    // 6 and 7 March. 6 March inserts fine; 7 March collides. The collision is
    // therefore the SECOND row of the batch, not the first.
    const collide = await call(vb.updateBookingWindow, ownerReq({
      params: { bookingId: String(bookingB._id) },
      body: { checkIn: "2027-03-03T00:00:00.000Z", checkOut: "2027-03-07T12:00:00.000Z" },
    }));
    ok(collide.code === 409, `the move → 409 (got ${collide.code})`);
    ok(collide.body.code === "calendar_conflict", "…coded as a calendar conflict");
    ok(
      (collide.body.conflicts || []).some((c) => c.day === "2027-03-07" && c.heldBy && c.heldBy.kind === "booking"),
      "…naming the date AND the other side (a booking)"
    );
    ok(
      /Rival Couple/.test(JSON.stringify(collide.body.conflicts)),
      "…by the other couple's name, so the owner knows who to call"
    );
    ok(/Nothing was changed/.test(collide.body.message || ""), `…and says so: "${collide.body.message}"`);

    const afterB = distinct(await blockedDays(bookingB._id));
    ok(
      afterB.join(",") === beforeB.join(","),
      `the booking still holds EXACTLY its original 5 days (got ${afterB.join(", ")})`
    );
    ok(
      (await VenueSpaceDate.countDocuments({ venue: venue._id, space: hall, date: iso("2027-03-06") })) === 0,
      "…6 March, which DID insert before the clash, was rolled back — no orphan block"
    );
    ok(
      (await VenueSpaceDate.countDocuments({ venue: venue._id, space: hall, date: iso("2027-03-01") })) === 1,
      "…1 March was never released — the claim failed before any release could happen"
    );
    const rivalRow = await VenueSpaceDate.findOne({ venue: venue._id, space: hall, date: iso("2027-03-07") }).lean();
    ok(
      String(rivalRow.bookingRef) === String(rivalBooking._id),
      "…and the rival's own row is untouched and still theirs"
    );
    const lB = await VenueEnquiry.findById(leadB._id).lean();
    const bB = await VenueBooking.findById(bookingB._id).lean();
    ok(
      venueDateKey(lB.checkIn) === "2027-03-01" && venueDateKey(bB.checkIn) === "2027-03-01",
      "…and neither copy of the window moved"
    );

    // The same move minus the clash must still work, proving the refusal was
    // about the collision and not about the shape of the move.
    await VenueSpaceDate.deleteOne({ _id: rivalRow._id });
    const clean = await call(vb.updateBookingWindow, ownerReq({
      params: { bookingId: String(bookingB._id) },
      body: { checkIn: "2027-03-03T00:00:00.000Z", checkOut: "2027-03-07T12:00:00.000Z" },
    }));
    ok(clean.code === 200, `with the date free, the identical move succeeds (got ${clean.code})`);
    const afterClean = distinct(await blockedDays(bookingB._id));
    ok(
      afterClean.join(",") === "2027-03-03,2027-03-04,2027-03-05,2027-03-06,2027-03-07",
      `…claiming 6–7 March and releasing 1–2 March (got ${afterClean.join(", ")})`
    );
    ok(clean.body.calendar.added === 2 && clean.body.calendar.removed === 2, `…reported as +2 / −2 (got +${clean.body.calendar.added} / −${clean.body.calendar.removed})`);

    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error("FATAL", e);
    fail++;
  } finally {
    for (const v of created.venues) {
      await VenueSpaceDate.deleteMany({ venue: v });
      await VenueHold.deleteMany({ venue: v });
      await VenueBooking.deleteMany({ venue: v });
      await VenueEnquiry.deleteMany({ venueId: v });
      await Venue.deleteOne({ _id: v });
    }
    await VenueOwner.deleteMany({ _id: { $in: created.owners } });
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
