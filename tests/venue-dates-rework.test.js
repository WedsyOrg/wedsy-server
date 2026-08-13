// BUILD2 S1/S2 — unfinalised dates, and the consequences of moving a window.
// Run:  node tests/venue-dates-rework.test.js
//
//   A. S1 the unfinalised state — a lead can say "December 2026, day
//      undecided" without inventing a precise date, and the two states are
//      mutually exclusive on every write path.
//   B. S1 functions cannot exist without dates.
//   C. S1 finalise / revert — one-way in the UI, both ways in the model.
//   D. S2(a) a window move that would strand functions NAMES them.
//   E. S2(b) a window move that strands a hold refuses until acknowledged,
//      and NEVER releases the hold (invariant #12's rule, applied to edits).
//   F. S2(c) a booked lead refuses the date change outright.
//   G. window-impact preflight answers all three without changing anything.
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueHold = require("../models/VenueHold");
const VenueBooking = require("../models/VenueBooking");
const VenueFollowUp = require("../models/VenueFollowUp");
const VenueTask = require("../models/VenueTask");
const VenueTeamMember = require("../models/VenueTeamMember");
const VenueOwner = require("../models/VenueOwner");
const VenueLeadInteraction = require("../models/VenueLeadInteraction");

const enq = require("../controllers/venueEnquiry");

const TAG = `venue-dates-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const created = { venues: [], owners: [] };

const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const venue = await Venue.create({
      name: `${TAG}-v`,
      slug: `${TAG}-v`,
      spaces: [{ name: "Lawn", isBookable: true }, { name: "Hall", isBookable: true }],
    });
    created.venues.push(venue._id);
    const ownerDoc = await VenueOwner.create({ venueId: venue._id, name: "Owner", phone: `${TAG}own`, isActive: true });
    created.owners.push(ownerDoc._id);
    const OWNER = ownerDoc._id;
    const spaceA = venue.spaces[0]._id;

    const req = (extra = {}) => ({
      params: { slug: venue.slug, ...(extra.params || {}) },
      query: extra.query || {},
      body: extra.body || {},
      venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: OWNER },
      venueMember: null,
    });

    // ── A. the unfinalised state ──
    console.log("\n[A. S1: a lead can be 'December 2026, day undecided']");
    const unfin = await call(enq.createManualLead, req({
      body: { coupleName: "Undecided Couple", couplePhone: "9000801", source: "referral", datesFinalised: false, approximatePeriod: { month: 12, year: 2026 } },
    }));
    ok(unfin.code === 201, "create with datesFinalised:false → 201");
    const unfinLead = await VenueEnquiry.findById(unfin.body.enquiry._id).lean();
    ok(unfinLead.datesFinalised === false, "…stored as unfinalised");
    ok(unfinLead.approximatePeriod.month === 12 && unfinLead.approximatePeriod.year === 2026, "…carrying the approximate period");
    ok(!unfinLead.checkIn && !unfinLead.checkOut, "…with NO check-in/check-out");
    ok(!unfinLead.eventDate, "…and no eventDate — it stays out of date-keyed views rather than landing on a wrong day");

    const legacy = await call(enq.createManualLead, req({ body: { coupleName: "Normal", couplePhone: "9000802", source: "referral", checkIn: "2026-09-30T10:00:00Z" } }));
    ok(legacy.code === 201 && (await VenueEnquiry.findById(legacy.body.enquiry._id).lean()).datesFinalised === true,
      "an ordinary lead defaults to finalised — existing rows keep their meaning");

    const both = await call(enq.createManualLead, req({
      body: { coupleName: "Contradiction", couplePhone: "9000803", source: "referral", datesFinalised: false, approximatePeriod: { month: 12, year: 2026 }, checkIn: "2026-12-05T10:00:00Z" },
    }));
    ok(both.code === 400, "a body carrying BOTH a window and 'not finalised' is refused, not silently half-applied");

    const noPeriod = await call(enq.createManualLead, req({ body: { coupleName: "No period", couplePhone: "9000804", source: "referral", datesFinalised: false } }));
    ok(noPeriod.code === 400, "unfinalised without an approximatePeriod → 400");

    const badDay = await call(enq.createManualLead, req({
      body: { coupleName: "Feb 31", couplePhone: "9000805", source: "referral", datesFinalised: false, approximatePeriod: { month: 2, year: 2027, day: 31 } },
    }));
    ok(badDay.code === 400, "31 February is refused — an approximate day still has to exist");

    // Model-level backstop: bypass the controller entirely.
    let modelRejected = false;
    try {
      await VenueEnquiry.create({ venueId: venue._id, coupleName: "Direct", datesFinalised: false, approximatePeriod: { month: 3, year: 2027 }, checkIn: new Date("2027-03-01T10:00:00Z") });
    } catch (e) { modelRejected = e.name === "ValidationError"; }
    ok(modelRejected, "the MODEL refuses the contradictory pair too — not just the controller");

    // ── B. functions need dates ──
    console.log("\n[B. S1: functions cannot exist without dates]");
    let fnRejected = false;
    try {
      await VenueEnquiry.create({
        venueId: venue._id, coupleName: "Fn no dates", datesFinalised: false, approximatePeriod: { month: 4, year: 2027 },
        functions: [{ name: "wedding", date: new Date("2027-04-10T10:00:00Z") }],
      });
    } catch (e) { fnRejected = e.name === "ValidationError"; }
    ok(fnRejected, "an unfinalised lead with functions is refused — there is no window to validate them against");

    // ── C. finalise / revert ──
    console.log("\n[C. S1: finalise, and the revert the model still allows]");
    const fin = await call(enq.updateEnquiry, req({
      params: { enquiryId: String(unfinLead._id) },
      body: { datesFinalised: true, checkIn: "2026-12-11T10:30:00Z", checkOut: "2026-12-12T05:00:00Z" },
    }));
    ok(fin.code === 200, "finalise → 200");
    const finLead = await VenueEnquiry.findById(unfinLead._id).lean();
    ok(finLead.datesFinalised === true && !!finLead.checkIn, "…now finalised with a real window");
    ok(!finLead.approximatePeriod.month, "…and the approximate period is cleared — never both states at once");
    ok(finLead.activities.some((a) => a.type === "dates_finalised"), "…recorded on the timeline");

    const finNoDate = await call(enq.updateEnquiry, req({
      params: { enquiryId: String((await VenueEnquiry.create({ venueId: venue._id, coupleName: "U2", datesFinalised: false, approximatePeriod: { month: 5, year: 2027 } }))._id) },
      body: { datesFinalised: true },
    }));
    ok(finNoDate.code === 400, "finalising with no check-in is refused — that is the dateless hole this slice closes");

    const revert = await call(enq.updateEnquiry, req({
      params: { enquiryId: String(unfinLead._id) },
      body: { datesFinalised: false, approximatePeriod: { month: 1, year: 2027 } },
    }));
    ok(revert.code === 200, "the model ALLOWS reverting — a couple can un-decide (explicit action, never an accident)");
    const reverted = await VenueEnquiry.findById(unfinLead._id).lean();
    ok(!reverted.checkIn && !reverted.checkOut && !reverted.eventDate, "…and the window is cleared on the way back");
    ok(reverted.activities.some((a) => a.type === "dates_unfinalised"), "…also recorded");

    // ── D. S2(a) stranded functions are NAMED ──
    console.log("\n[D. S2(a): a window move that would strand functions names them]");
    const withFns = await VenueEnquiry.create({
      venueId: venue._id, coupleName: "Two day", couplePhone: "9000810",
      checkIn: new Date("2026-09-30T10:30:00Z"), checkOut: new Date("2026-10-01T16:30:00Z"),
      functions: [
        { name: "sangeet", date: new Date("2026-09-30T12:00:00Z"), space: spaceA },
        { name: "wedding", date: new Date("2026-10-01T12:00:00Z"), space: spaceA },
      ],
    });
    const shrink = await call(enq.updateEnquiry, req({
      params: { enquiryId: String(withFns._id) },
      body: { checkIn: "2026-09-30T10:30:00Z", checkOut: "2026-09-30T18:00:00Z" },
    }));
    ok(shrink.code === 400, "shrinking the window under an existing function → 400");
    ok(Array.isArray(shrink.body.conflictingFunctions) && shrink.body.conflictingFunctions.length === 1,
      "THE FIX: the response NAMES the conflicting function (was: a message naming none of them)");
    ok(shrink.body.conflictingFunctions[0].name === "wedding" && shrink.body.conflictingFunctions[0].day === "2026-10-01",
      "…with the function and the day the owner has to move");
    ok((await VenueEnquiry.findById(withFns._id).lean()).checkOut.toISOString() === "2026-10-01T16:30:00.000Z",
      "…and nothing was written");

    // ── E. S2(b) a stranded hold blocks until acknowledged, and is never released ──
    console.log("\n[E. S2(b): a hold on the old dates is surfaced, never silently released]");
    const held = await VenueEnquiry.create({
      venueId: venue._id, coupleName: "Held", couplePhone: "9000811",
      checkIn: new Date("2026-11-10T10:30:00Z"), checkOut: new Date("2026-11-11T10:30:00Z"),
    });
    const hold = await VenueHold.create({
      venue: venue._id, dates: [new Date("2026-11-10T00:00:00Z")], requestedBy: "owner",
      requestedByName: "Held", linkedEnquiry: held._id, status: "approved",
      expiresAt: new Date(Date.now() + 7 * 86400000),
    });
    const moveHeld = await call(enq.updateEnquiry, req({
      params: { enquiryId: String(held._id) },
      body: { checkIn: "2026-11-20T10:30:00Z", checkOut: "2026-11-21T10:30:00Z" },
    }));
    ok(moveHeld.code === 409, "moving the window off a held date → 409, not a silent success");
    ok(moveHeld.body.staleHolds && moveHeld.body.staleHolds.length === 1, "…the hold is surfaced for an explicit decision");
    ok((await VenueHold.findById(hold._id).lean()).status === "approved", "…and the hold is NOT auto-released (invariant #12's rule)");
    ok((await VenueEnquiry.findById(held._id).lean()).checkIn.toISOString() === "2026-11-10T10:30:00.000Z", "…and the window did not move");

    const moveAck = await call(enq.updateEnquiry, req({
      params: { enquiryId: String(held._id) },
      body: { checkIn: "2026-11-20T10:30:00Z", checkOut: "2026-11-21T10:30:00Z", acknowledgeStaleHolds: true },
    }));
    ok(moveAck.code === 200, "with an explicit acknowledgement the move goes through");
    ok(moveAck.body.staleHolds && moveAck.body.staleHolds.length === 1, "…and the response still hands back the hold to release or re-place");
    ok((await VenueHold.findById(hold._id).lean()).status === "approved", "…the hold STILL was not released — the owner does that, not us");

    // ── F. S2(c) a booking refuses the change outright ──
    console.log("\n[F. S2(c): a booked lead does not move its dates from here]");
    const bookedLead = await VenueEnquiry.create({
      venueId: venue._id, coupleName: "Booked", couplePhone: "9000812", stage: "booked",
      checkIn: new Date("2026-12-20T10:30:00Z"), checkOut: new Date("2026-12-21T10:30:00Z"),
    });
    const bk = await VenueBooking.create({ venue: venue._id, enquiry: bookedLead._id, coupleName: "Booked", status: "confirmed" });
    const moveBooked = await call(enq.updateEnquiry, req({
      params: { enquiryId: String(bookedLead._id) },
      body: { checkIn: "2026-12-27T10:30:00Z", checkOut: "2026-12-28T10:30:00Z" },
    }));
    ok(moveBooked.code === 409, "a lead with a booking refuses the date change (409)");
    ok(String(moveBooked.body.bookingId) === String(bk._id), "…and points at the booking to go through instead");
    ok((await VenueEnquiry.findById(bookedLead._id).lean()).checkIn.toISOString() === "2026-12-20T10:30:00.000Z",
      "…and the calendar-bearing dates were NOT moved underneath the booking");
    const ackBooked = await call(enq.updateEnquiry, req({
      params: { enquiryId: String(bookedLead._id) },
      body: { checkIn: "2026-12-27T10:30:00Z", checkOut: "2026-12-28T10:30:00Z", acknowledgeStaleHolds: true },
    }));
    ok(ackBooked.code === 409, "…and no acknowledgement flag can talk it into moving them");

    // ── G. the preflight ──
    console.log("\n[G. S2: window-impact answers all three, changing nothing]");
    const impact = await call(enq.getWindowImpact, req({
      params: { enquiryId: String(withFns._id) },
      query: { checkIn: "2026-09-30T10:30:00Z", checkOut: "2026-09-30T18:00:00Z" },
    }));
    ok(impact.code === 200, "preflight → 200 even when the move would fail");
    ok(impact.body.conflictingFunctions.length === 1 && impact.body.requires.resolveFunctions === true,
      "…lists the function to move BEFORE the owner presses save");
    ok(impact.body.blocked === false, "…not blocked (no booking on this lead)");
    const impactBooked = await call(enq.getWindowImpact, req({
      params: { enquiryId: String(bookedLead._id) },
      query: { checkIn: "2026-12-27T10:30:00Z", checkOut: "2026-12-28T10:30:00Z" },
    }));
    ok(impactBooked.body.blocked === true && String(impactBooked.body.booking._id) === String(bk._id),
      "…and reports a booked lead as blocked, so the UI never offers the edit");
    ok((await VenueEnquiry.findById(withFns._id).lean()).checkOut.toISOString() === "2026-10-01T16:30:00.000Z",
      "…the preflight wrote nothing");

    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error("FATAL", e);
    fail++;
  } finally {
    for (const v of created.venues) {
      const leads = await VenueEnquiry.find({ venueId: v }).select("_id").lean();
      const ids = leads.map((l) => l._id);
      await VenueFollowUp.deleteMany({ lead: { $in: ids } });
      await VenueLeadInteraction.deleteMany({ enquiry: { $in: ids } });
      await VenueTask.deleteMany({ venue: v });
      await VenueHold.deleteMany({ venue: v });
      await VenueBooking.deleteMany({ venue: v });
      await VenueEnquiry.deleteMany({ venueId: v });
      await VenueTeamMember.deleteMany({ venueId: v });
      await Venue.deleteOne({ _id: v });
    }
    await VenueOwner.deleteMany({ _id: { $in: created.owners } });
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
