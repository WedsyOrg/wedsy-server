// BOOKING 1 — step 1 blocks SPACES, not the couple's itinerary. Run:
//   node tests/venue-confirm-spaces.test.js
//
// ── WHAT THIS IS ABOUT ──────────────────────────────────────────────────────
// The confirm wizard's step 1 listed the lead's FUNCTIONS and took each one's
// own `space`. Three functions in one hall offered three rows for one space,
// and a function whose space was never set sent `space: undefined` — which this
// controller reads as ENTIRE PROPERTY. So an incomplete itinerary silently
// claimed every space on the calendar.
//
// The picker now offers the venue's real spaces and sends `spaces: [ids]`. This
// suite asserts the EXACT VenueSpaceDate rows written for both answers, read
// back off the stored collection rather than the response body.
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueBooking = require("../models/VenueBooking");
const VenueSpaceDate = require("../models/VenueSpaceDate");
const bookings = require("../controllers/venueBooking");
const { WHOLE_VENUE_SPACE_ID, isWholeVenueSpace } = require("../utils/venueWholeVenue");

const TAG = `bk1-${Date.now()}`;
const OWNER = new mongoose.Types.ObjectId();
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (a, b, label) => ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const created = [];

const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const ownerReq = (venue, extra = {}) => ({
  params: { slug: venue.slug, ...(extra.params || {}) },
  query: extra.query || {}, body: extra.body || {},
  venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: OWNER },
  venueMember: null,
});
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };

/** The stored rows for a booking, as "spaceName|YYYY-MM-DD", sorted. */
async function rowsFor(venue, bookingId, nameOf) {
  const rows = await VenueSpaceDate.find({ venue: venue._id, bookingRef: bookingId }).select("space date state").lean();
  return rows
    .map((r) => `${nameOf(r.space)}|${new Date(r.date).toISOString().slice(0, 10)}`)
    .sort();
}

(async () => {
  let venue;
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    venue = await Venue.create({
      name: `${TAG}-v`, slug: `${TAG}-v`,
      spaces: [
        { name: "North lawn", type: "outdoor", isBookable: true },
        { name: "Banquet hall", type: "indoor", isBookable: true },
        { name: "Foyer", type: "indoor", isBookable: false },
      ],
    });
    created.push(venue._id);
    const lawn = String(venue.spaces[0]._id);
    const hall = String(venue.spaces[1]._id);
    const foyer = String(venue.spaces[2]._id);
    const nameOf = (id) => {
      if (isWholeVenueSpace(id)) return "ENTIRE";
      const s = (venue.spaces || []).find((x) => String(x._id) === String(id));
      return s ? s.name : `?${id}`;
    };
    const mkLead = (extra = {}) => VenueEnquiry.create({
      venueId: venue._id, coupleName: `${TAG} ${Math.random().toString(36).slice(2, 7)}`,
      couplePhone: String(Math.floor(Math.random() * 1e10)), stage: "negotiating", ...extra,
    });

    // ══ 1. SELECTED SPACES ═════════════════════════════════════════════════
    console.log("\n[selected spaces — exactly what was ticked, nothing more]");
    {
      const lead = await mkLead({ guestCount: 300 });
      const r = await call(bookings.confirmBookingFromLead, ownerReq(venue, {
        params: { enquiryId: String(lead._id) },
        body: { functions: [{ date: "2031-02-10", spaces: [lawn, hall], name: "Wedding", pax: 300 }], totalValue: 500000 },
      }));
      eq(r.code, 200, "confirm succeeds");
      const bId = r.body.booking._id;

      // Read the STORED rows, not the response body.
      const got = await rowsFor(venue, bId, nameOf);
      eq(JSON.stringify(got), JSON.stringify(["Banquet hall|2031-02-10", "North lawn|2031-02-10"]),
        "🔴 exactly two rows — one per ticked space, on the one date");
      ok(!got.some((k) => k.startsWith("ENTIRE")), "🔴 …and NO whole-venue sentinel, because this was not a whole-venue claim");
      ok(!got.some((k) => k.startsWith("Foyer")), "…and nothing for the space that was not ticked");

      // The unticked space is still sellable — the positive form of the above.
      const free = await VenueSpaceDate.countDocuments({ venue: venue._id, space: venue.spaces[2]._id, date: new Date("2031-02-10T00:00:00Z") });
      eq(free, 0, "🔴 the unticked space has no row at all, so it remains bookable");

      // booking.days survives: it is built from the row's name and pax.
      const bk = await VenueBooking.findById(bId).lean();
      eq(bk.days.length, 1, "one booking day");
      eq(bk.days[0].eventType, "Wedding", "🔴 …carrying the function name, which booking.days is built from");
      eq(bk.days[0].guestCount, 300, "…and the pax");
      eq(JSON.stringify([...bk.days[0].spaces].sort()), JSON.stringify(["Banquet hall", "North lawn"]),
        "…and naming both spaces rather than a single one");
    }

    // ══ 2. ENTIRE PROPERTY ═════════════════════════════════════════════════
    console.log("\n[entire property — every bookable space PLUS the sentinel]");
    {
      const lead = await mkLead({ guestCount: 300 });
      const r = await call(bookings.confirmBookingFromLead, ownerReq(venue, {
        params: { enquiryId: String(lead._id) },
        body: { functions: [{ date: "2031-03-10", name: "Wedding", pax: 300 }], totalValue: 500000 },
      }));
      eq(r.code, 200, "confirm succeeds");
      const got = await rowsFor(venue, r.body.booking._id, nameOf);
      eq(JSON.stringify(got),
        JSON.stringify(["Banquet hall|2031-03-10", "ENTIRE|2031-03-10", "North lawn|2031-03-10"].sort()),
        "🔴 both bookable spaces AND the whole-venue sentinel");
      ok(got.some((k) => k.startsWith("ENTIRE")),
        "🔴 the sentinel is what makes a SECOND whole-property claim collide on the unique index");
      ok(!got.some((k) => k.startsWith("Foyer")), "…and an unbookable space is still not claimed");

      const bk = await VenueBooking.findById(r.body.booking._id).lean();
      eq(JSON.stringify(bk.days[0].spaces), JSON.stringify(["Entire property"]),
        "🔴 …and the booking says 'Entire property', not a list that would read as ticking them all");
    }

    // ══ 3. THE SILENT WHOLE-VENUE CLAIM, WHICH IS WHY `spaces: []` IS REFUSED
    console.log("\n[an empty tick list is refused, not read as the whole venue]");
    {
      const lead = await mkLead();
      const r = await call(bookings.confirmBookingFromLead, ownerReq(venue, {
        params: { enquiryId: String(lead._id) },
        body: { functions: [{ date: "2031-04-10", spaces: [], name: "Wedding" }], totalValue: 100000 },
      }));
      eq(r.code, 400, "🔴 spaces: [] → 400");
      ok(/pick at least one space/.test((r.body || {}).message || ""),
        `…saying what to do: "${(r.body || {}).message}"`);
      const any = await VenueSpaceDate.countDocuments({ venue: venue._id, date: new Date("2031-04-10T00:00:00Z") });
      eq(any, 0, "🔴 …and NOTHING was written — 'ticked nothing' never claims the calendar");
    }

    // ══ 4. VALIDATION ══════════════════════════════════════════════════════
    console.log("\n[the space set is validated against this venue]");
    {
      const lead = await mkLead();
      const foreign = String(new mongoose.Types.ObjectId());
      const bad = await call(bookings.confirmBookingFromLead, ownerReq(venue, {
        params: { enquiryId: String(lead._id) },
        body: { functions: [{ date: "2031-05-10", spaces: [lawn, foreign] }], totalValue: 100000 },
      }));
      eq(bad.code, 400, "a space from another venue → 400");

      const lead2 = await mkLead();
      const unbookable = await call(bookings.confirmBookingFromLead, ownerReq(venue, {
        params: { enquiryId: String(lead2._id) },
        body: { functions: [{ date: "2031-05-11", spaces: [lawn, foyer] }], totalValue: 100000 },
      }));
      eq(unbookable.code, 400, "an unbookable space → 400");
      const any = await VenueSpaceDate.countDocuments({ venue: venue._id, date: { $in: [new Date("2031-05-10T00:00:00Z"), new Date("2031-05-11T00:00:00Z")] } });
      eq(any, 0, "…and neither wrote a partial claim before refusing");

      const lead3 = await mkLead();
      const dup = await call(bookings.confirmBookingFromLead, ownerReq(venue, {
        params: { enquiryId: String(lead3._id) },
        body: { functions: [{ date: "2031-05-12", spaces: [lawn, lawn, hall] }], totalValue: 100000 },
      }));
      eq(dup.code, 200, "the same space listed twice is not an error");
      const got = await rowsFor(venue, dup.body.booking._id, nameOf);
      eq(got.length, 2, "🔴 …it is deduped into one row per space, not double-claimed");
    }

    // ══ 5. THE WINDOW STILL WIDENS ═════════════════════════════════════════
    console.log("\n[with a finalised window, the ticked spaces are held across every day of it]");
    {
      const lead = await mkLead({
        checkIn: new Date("2031-06-10T10:00:00Z"),
        checkOut: new Date("2031-06-12T10:00:00Z"),
      });
      const r = await call(bookings.confirmBookingFromLead, ownerReq(venue, {
        params: { enquiryId: String(lead._id) },
        body: { functions: [{ date: "2031-06-11", spaces: [lawn], name: "Wedding" }], totalValue: 500000 },
      }));
      eq(r.code, 200, "confirm succeeds");
      const got = await rowsFor(venue, r.body.booking._id, nameOf);
      eq(JSON.stringify(got),
        JSON.stringify(["North lawn|2031-06-10", "North lawn|2031-06-11", "North lawn|2031-06-12"]),
        "🔴 the ticked space is claimed on EVERY day of the window, not only the function's day");
      ok(!got.some((k) => k.startsWith("Banquet")), "…and only the ticked space, on all of them");
    }

    // ══ 6. THE SECOND CLAIM STILL COLLIDES ═════════════════════════════════
    console.log("\n[a ticked space already booked refuses, and writes nothing new]");
    {
      const lead = await mkLead();
      const first = await call(bookings.confirmBookingFromLead, ownerReq(venue, {
        params: { enquiryId: String(lead._id) },
        body: { functions: [{ date: "2031-07-10", spaces: [hall] }], totalValue: 100000 },
      }));
      eq(first.code, 200, "the first booking takes the hall");
      const before = await VenueSpaceDate.countDocuments({ venue: venue._id, date: new Date("2031-07-10T00:00:00Z") });

      const lead2 = await mkLead();
      const clash = await call(bookings.confirmBookingFromLead, ownerReq(venue, {
        params: { enquiryId: String(lead2._id) },
        body: { functions: [{ date: "2031-07-10", spaces: [lawn, hall] }], totalValue: 100000 },
      }));
      eq(clash.code, 409, "🔴 a second booking wanting the same hall → 409");
      const after = await VenueSpaceDate.countDocuments({ venue: venue._id, date: new Date("2031-07-10T00:00:00Z") });
      eq(after, before, "🔴 …and the lawn it could have had was rolled back — claim-then-release, never a partial hold");
    }
  } catch (err) {
    fail += 1;
    console.error("\nFATAL", err);
  } finally {
    try {
      for (const v of created) {
        await VenueSpaceDate.deleteMany({ venue: v });
        await VenueBooking.deleteMany({ venue: v });
        await VenueEnquiry.deleteMany({ venueId: v });
        await Venue.deleteOne({ _id: v });
      }
    } catch (e) { /* best effort */ }
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  }
})();
