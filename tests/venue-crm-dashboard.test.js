// MB-CRM S4 dashboard overview. Run: node tests/venue-crm-dashboard.test.js
// Focus: the Proof card is honest — cold (>=7d gap) → revived (quick-log after
// the gap) → saved (booked) — and the alerts are real counts. Plus the empty
// state when there is no history. Direct controller call, mock req/res.
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueLeadInteraction = require("../models/VenueLeadInteraction");

const { getCrmOverview } = require("../controllers/venueCrmDashboard");

const TAG = `mbcrm-s4-${Date.now()}`;
const OWNER = new mongoose.Types.ObjectId();
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const created = { venues: [] };

const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const ownerReq = (venue) => ({ params: { slug: venue.slug }, query: {}, body: {}, venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: OWNER }, venueMember: null });
const call = async (venue) => { const res = mockRes(); await getCrmOverview(ownerReq(venue), res); return res; };

const DAY = 24 * 60 * 60 * 1000;

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    // ── venue with history ──
    const venue = await Venue.create({ name: `${TAG}-v`, slug: `${TAG}-v` });
    created.venues.push(venue._id);
    const now = Date.now();
    const t0 = new Date(now - 30 * DAY);

    // A: booked, cold 10-day gap then a call → a genuine save
    const A = await VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} Sharma`, stage: "booked", estimatedValue: 1000000 });
    // B: booked, only a 2-day gap → NOT a save
    const B = await VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} Quick`, stage: "booked", estimatedValue: 500000 });
    // C: active, no follow-up, unassigned
    await VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} NoFU`, stage: "new" });
    // D: active, overdue follow-up
    await VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} Overdue`, stage: "contacted", followUpDate: new Date(now - 3 * DAY) });

    // Backdated interactions (explicit createdAt via the native collection).
    await VenueLeadInteraction.collection.insertMany([
      { enquiry: A._id, venue: venue._id, type: "enquiry", note: "", createdAt: t0, updatedAt: t0 },
      { enquiry: A._id, venue: venue._id, type: "call", note: "revived", createdAt: new Date(t0.getTime() + 10 * DAY), updatedAt: new Date(t0.getTime() + 10 * DAY) },
      { enquiry: B._id, venue: venue._id, type: "enquiry", note: "", createdAt: t0, updatedAt: t0 },
      { enquiry: B._id, venue: venue._id, type: "call", note: "", createdAt: new Date(t0.getTime() + 2 * DAY), updatedAt: new Date(t0.getTime() + 2 * DAY) },
    ]);

    const res = await call(venue);
    ok(res.code === 200, "overview returns 200");

    // proof honesty
    ok(res.body.proof.empty === false, "proof is not empty when a save exists");
    ok(res.body.proof.count === 1, "exactly ONE save (A revived after a >=7d gap; B did not)");
    ok(res.body.proof.latest && res.body.proof.latest.name === `${TAG} Sharma`, "latest save is the revived-then-booked lead");
    ok(res.body.proof.latest.coldDays === 10, "coldDays reflects the real 10-day gap");
    ok(res.body.proof.revivedValue === 1000000, "revivedValue sums only genuine saves");

    // alerts / my-day (real counts)
    ok(res.body.myDay.noFollowUp >= 1, "noFollowUp alert counts leads with no follow-up set");
    ok(res.body.myDay.unassigned >= 1, "unassigned alert counts unassigned non-terminal leads");
    ok(res.body.myDay.overdue >= 1, "overdue counts past-due follow-ups");
    ok(res.body.pipeline.total === 4 && res.body.pipeline.stageCounts.booked === 2, "pipeline totals are real stage counts");

    // ── fresh venue: honest empty proof ──
    const fresh = await Venue.create({ name: `${TAG}-fresh`, slug: `${TAG}-fresh` });
    created.venues.push(fresh._id);
    const res2 = await call(fresh);
    ok(res2.body.proof.empty === true && res2.body.proof.count === 0 && res2.body.proof.latest === null, "a venue with no history returns an HONEST empty proof (no zero-value stat)");
    ok(res2.body.pipeline.conversionPct === null, "conversion is null (not 0%) when there are no leads");
  } catch (err) {
    console.error("FATAL", err);
    fail++;
  } finally {
    try {
      const vids = created.venues;
      await VenueEnquiry.deleteMany({ venueId: { $in: vids } });
      await VenueLeadInteraction.deleteMany({ venue: { $in: vids } });
      await Venue.deleteMany({ _id: { $in: vids } });
    } catch (e) { console.error("cleanup error", e.message); }
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
