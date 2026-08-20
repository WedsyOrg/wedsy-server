// MB-CRM-2 S2 — Confirm Booking orchestration (one creation path). Run:
//   node tests/venue-crm-s2.test.js
// Happy path, already-booked refusal, calendar-conflict rollback, hold
// conversion (+ explicit leftover release), scoped denial, and the
// quote-accept path regression.
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueTeamMember = require("../models/VenueTeamMember");
const VenueHold = require("../models/VenueHold");
const VenueBooking = require("../models/VenueBooking");
const VenueSpaceDate = require("../models/VenueSpaceDate");
const VenueQuote = require("../models/VenueQuote");
const VenueRunsheetItem = require("../models/VenueRunsheetItem");

const enq = require("../controllers/venueEnquiry");
const bookings = require("../controllers/venueBooking");
const quotes = require("../controllers/venueQuote");
const calendar = require("../controllers/venueCalendar");

const TAG = `mbcrm2-s2-${Date.now()}`;
const OWNER = new mongoose.Types.ObjectId();
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const created = { venues: [], members: [] };

const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const memberReq = (venue, member, extra = {}) => ({ params: { slug: venue.slug, ...(extra.params || {}) }, query: extra.query || {}, body: extra.body || {}, venueOwner: { type: "venue_owner", venueId: venue._id, memberId: member._id, role: member.role }, venueMember: member });
const ownerReq = (venue, extra = {}) => ({ params: { slug: venue.slug, ...(extra.params || {}) }, query: extra.query || {}, body: extra.body || {}, venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: OWNER }, venueMember: null });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    const venue = await Venue.create({
      name: `${TAG}-v`,
      slug: `${TAG}-v`,
      spaces: [
        { name: "North lawn", type: "outdoor", isBookable: true },
        { name: "Banquet hall", type: "indoor", isBookable: true },
        { name: "Foyer", type: "indoor", isBookable: false },
      ],
    });
    created.venues.push(venue._id);
    const lawn = String(venue.spaces[0]._id);
    const hall = String(venue.spaces[1]._id);
    const mkLead = (extra = {}) => VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} ${Math.random().toString(36).slice(2, 7)}`, couplePhone: String(Math.floor(Math.random() * 1e10)), stage: "negotiating", ...extra });

    // ── happy path ──
    console.log("\n[happy path]");
    const lead1 = await mkLead({ guestCount: 320 });
    const agreementId = new mongoose.Types.ObjectId();
    const r1 = await call(bookings.confirmBookingFromLead, ownerReq(venue, {
      params: { enquiryId: String(lead1._id) },
      body: {
        functions: [
          { date: "2026-12-13", space: lawn, name: "Mehendi", pax: 80 },
          { date: "2026-12-13", space: hall, name: "Sangeet", pax: 220 },
          { date: "2026-12-14", space: lawn, name: "Wedding", pax: 320 },
        ],
        tokenAmount: 300000,
        tokenMode: "UPI",
        paymentSchedule: [
          { label: "50%", amount: 1400000, dueDate: "2026-10-01" },
          { label: "Balance", amount: 1100000, dueDate: "2026-11-30" },
        ],
        agreementDocId: String(agreementId),
      },
    }));
    ok(r1.code === 200, `confirm-booking 200 (got ${r1.code}: ${r1.body && r1.body.message})`);
    ok(r1.body.blocked === 3 && r1.body.converted === 0, "3 date-spaces blocked, none from holds");
    const b1 = await VenueBooking.findOne({ enquiry: lead1._id }).lean();
    ok(!!b1, "booking exists (single-path create)");
    ok(b1.days.length === 2 && b1.days[0].eventType === "Mehendi + Sangeet" && b1.days[0].spaces.length === 2, "days grouped by date with joined event types + space names");
    ok(b1.paymentSchedule.length === 3 && /Token — received \(UPI\)/.test(b1.paymentSchedule[0].label) && b1.paymentSchedule[0].amount === 300000, "token leads the payment schedule");
    ok(b1.totalValue === 2800000, "totalValue = token + schedule");
    ok(String(b1.agreementDoc) === String(agreementId), "agreement doc linked");
    ok((await VenueSpaceDate.countDocuments({ venue: venue._id, bookingRef: b1._id, state: "booked" })) === 3, "3 booked calendar rows");
    const lead1After = await VenueEnquiry.findById(lead1._id).lean();
    ok(lead1After.stage === "booked", "lead stage → booked");
    ok(lead1After.notes.some((n) => /^BOOKED — 3 function/.test(n.text)), "BOOKED timeline entry written");
    ok(lead1After.activities.some((a) => a.via === "confirm_booking"), "stage change audited via confirm_booking");
    ok(lead1After.estimatedValue === 2800000, "estimatedValue follows the confirmed total");
    ok((await VenueRunsheetItem.countDocuments({ booking: b1._id })) > 0, "runsheet skeleton seeded for the booking days");
    const read1 = await call(enq.getEnquiryById, ownerReq(venue, { params: { enquiryId: String(lead1._id) } }));
    ok(String(read1.body.enquiry.bookingId) === String(b1._id), "lead read returns bookingId (booking↔lead resolvable)");

    // ── already-booked refusal ──
    console.log("\n[already-booked refusal]");
    const r1b = await call(bookings.confirmBookingFromLead, ownerReq(venue, {
      params: { enquiryId: String(lead1._id) },
      body: { functions: [{ date: "2027-01-05", space: lawn }] },
    }));
    ok(r1b.code === 409 && /already has a confirmed booking/.test(r1b.body.message), "second confirm on the same lead → 409");
    ok((await VenueSpaceDate.countDocuments({ venue: venue._id, bookingRef: b1._id })) === 3, "no extra rows on refusal");

    // ── calendar conflict: another lead wants a taken date-space ──
    console.log("\n[conflict + rollback]");
    const lead2 = await mkLead();
    const r2 = await call(bookings.confirmBookingFromLead, ownerReq(venue, {
      params: { enquiryId: String(lead2._id) },
      body: { functions: [{ date: "2026-12-20", space: hall, name: "Reception" }, { date: "2026-12-14", space: lawn, name: "Wedding" }] },
    }));
    ok(r2.code === 409 && /already held, booked, or blocked/.test(r2.body.message), "confirm over an already-booked date-space → 409");
    const b2 = await VenueBooking.findOne({ enquiry: lead2._id }).lean();
    ok((await VenueSpaceDate.countDocuments({ venue: venue._id, bookingRef: b2 ? b2._id : null })) === 0, "rollback: NO calendar rows survive the failed confirm (incl. the free date)");
    ok((await VenueEnquiry.findById(lead2._id).lean()).stage === "negotiating", "lead stage unchanged on refusal");

    // ── hold conversion + explicit leftover release ──
    console.log("\n[hold conversion]");
    const lead3 = await mkLead();
    const mkHold = await call(calendar.createHold, ownerReq(venue, { body: { dates: ["2027-02-10", "2027-02-12"], space: lawn, linkedEnquiry: String(lead3._id) } }));
    ok(mkHold.code === 201, "hold requested for the lead (2 dates, lawn)");
    const holdId = String(mkHold.body.hold._id);
    ok((await call(calendar.approveHold, ownerReq(venue, { params: { holdId } }))).code === 200, "hold approved (2 held rows)");
    const r3 = await call(bookings.confirmBookingFromLead, ownerReq(venue, {
      params: { enquiryId: String(lead3._id) },
      body: { functions: [{ date: "2027-02-10", space: lawn, name: "Wedding", pax: 200 }], tokenAmount: 100000 },
    }));
    ok(r3.code === 200, `hold-backed confirm 200 (got ${r3.code}: ${r3.body && r3.body.message})`);
    ok(r3.body.converted === 1 && r3.body.blocked === 1, "the lead's own held row CONVERTED to booked (no conflict with itself)");
    ok(r3.body.releasedLeftover === 1, "the unused held date released EXPLICITLY (counted, not silent)");
    ok((await VenueHold.findById(holdId).lean()).status === "converted", "hold graduates to converted");
    const lead3After = await VenueEnquiry.findById(lead3._id).lean();
    ok(lead3After.notes.some((n) => /unused held date-space\(s\) released/.test(n.text)), "leftover release logged on the lead timeline");
    ok((await VenueSpaceDate.countDocuments({ venue: venue._id, holdRef: holdId, state: "held" })) === 0, "no held rows remain under the converted hold");

    // ── venue-wide function (no space) claims every bookable space ──
    console.log("\n[venue-wide block]");
    const lead4 = await mkLead();
    const r4 = await call(bookings.confirmBookingFromLead, ownerReq(venue, {
      params: { enquiryId: String(lead4._id) },
      body: { functions: [{ date: "2027-03-03", name: "Wedding" }] },
    }));
    // 2 bookable spaces + the whole-venue SENTINEL = 3 rows. The sentinel is
    // what makes a second whole-property claim collide on a venue with no
    // spaces, and what lets a space added later be backfilled onto this date.
    // See utils/venueWholeVenue.js.
    ok(r4.code === 200 && r4.body.blocked === 3,
      "spaceless function blocks all bookable spaces (2) + the whole-venue sentinel, never the non-bookable one");
    {
      const { WHOLE_VENUE_SPACE_ID } = require("../utils/venueWholeVenue");
      const rows = await VenueSpaceDate.find({ venue: venue._id, date: new Date("2027-03-03T00:00:00.000Z") }).select("space").lean();
      ok(rows.some((r) => String(r.space) === String(WHOLE_VENUE_SPACE_ID)),
        "…and the extra row is the sentinel, not an accidental duplicate");
    }

    // ── validation ──
    console.log("\n[validation]");
    const lead5 = await mkLead();
    const p5 = { enquiryId: String(lead5._id) };
    ok((await call(bookings.confirmBookingFromLead, ownerReq(venue, { params: p5, body: {} }))).code === 400, "no functions → 400");
    ok((await call(bookings.confirmBookingFromLead, ownerReq(venue, { params: p5, body: { functions: [{ date: "not-a-date" }] } }))).code === 400, "bad date → 400");
    ok((await call(bookings.confirmBookingFromLead, ownerReq(venue, { params: p5, body: { functions: [{ date: "2027-04-01", space: String(venue.spaces[2]._id) }] } }))).code === 400, "non-bookable space → 400");
    ok((await call(bookings.confirmBookingFromLead, ownerReq(venue, { params: p5, body: { functions: [{ date: "2027-04-01" }], agreementDocId: "junk" } }))).code === 400, "malformed agreementDocId → 400");
    ok((await VenueSpaceDate.countDocuments({ venue: venue._id, date: new Date("2027-04-01T00:00:00Z") })) === 0, "failed validations blocked nothing");

    // ── scoped denial ──
    console.log("\n[scoped denial]");
    const salesA = await VenueTeamMember.create({ venueId: venue._id, ownerId: OWNER, name: `${TAG}-A`, phone: `${TAG}A`, role: "sales", isActive: true });
    const salesB = await VenueTeamMember.create({ venueId: venue._id, ownerId: OWNER, name: `${TAG}-B`, phone: `${TAG}B`, role: "sales", isActive: true });
    created.members.push(salesA._id, salesB._id);
    const leadA = await mkLead({ assignedTo: salesA._id });
    const bookingsBefore = await VenueBooking.countDocuments({ venue: venue._id });
    const rD = await call(bookings.confirmBookingFromLead, memberReq(venue, salesB, {
      params: { enquiryId: String(leadA._id) },
      body: { functions: [{ date: "2027-05-05", space: lawn }], tokenAmount: 50000 },
    }));
    ok(rD.code === 404, "scoped member confirming an unseen lead → 404 (not 403)");
    ok((await VenueBooking.countDocuments({ venue: venue._id })) === bookingsBefore, "no booking created for the out-of-scope lead");
    ok((await VenueSpaceDate.countDocuments({ venue: venue._id, date: new Date("2027-05-05T00:00:00Z") })) === 0, "no calendar rows written");
    const leadAAfter = await VenueEnquiry.findById(leadA._id).lean();
    ok(leadAAfter.stage === "negotiating" && (leadAAfter.notes || []).length === 0, "lead untouched (stage + timeline)");

    // ── quote-path regression: same creation primitive, unchanged behaviour ──
    console.log("\n[quote-path regression]");
    const lead6 = await mkLead({ estimatedValue: 0 });
    const q = await VenueQuote.create({ venue: venue._id, enquiry: lead6._id, version: 1, status: "accepted", lineItems: [{ label: "hire", category: "venue_hire", qty: 1, unitPrice: 500000 }], totals: { subtotal: 500000, taxable: 500000, gst: 90000, grandTotal: 590000 } });
    const rq = await call(quotes.confirmBookingFromQuote, ownerReq(venue, { params: { quoteId: String(q._id) } }));
    ok(rq.code === 200 && rq.body.booking, "confirmBookingFromQuote still 200 + booking");
    ok(rq.body.booking.totalValue === 590000, "quote grandTotal still drives totalValue");
    const b6 = await VenueBooking.findOne({ enquiry: lead6._id }).lean();
    ok(!!b6 && (await VenueSpaceDate.countDocuments({ venue: venue._id, bookingRef: b6._id })) === 0, "quote path behaviour unchanged (no calendar rows — blocking stays wizard/convert-hold territory)");
    const rq2 = await call(quotes.confirmBookingFromQuote, ownerReq(venue, { params: { quoteId: String(q._id) } }));
    ok(rq2.code === 200 && String(rq2.body.booking._id) === String(b6._id), "idempotent: re-confirm returns the SAME booking (unique enquiry index)");
  } catch (err) {
    console.error("FATAL", err);
    fail++;
  } finally {
    try {
      const vids = created.venues;
      const bs = await VenueBooking.find({ venue: { $in: vids } }).select("_id").lean();
      await VenueRunsheetItem.deleteMany({ venue: { $in: vids } });
      await VenueSpaceDate.deleteMany({ venue: { $in: vids } });
      await VenueQuote.deleteMany({ venue: { $in: vids } });
      await VenueBooking.deleteMany({ _id: { $in: bs.map((b) => b._id) } });
      await VenueHold.deleteMany({ venue: { $in: vids } });
      await VenueEnquiry.deleteMany({ venueId: { $in: vids } });
      await VenueTeamMember.deleteMany({ _id: { $in: created.members } });
      await Venue.deleteMany({ _id: { $in: vids } });
    } catch (e) { console.error("cleanup error", e.message); }
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
