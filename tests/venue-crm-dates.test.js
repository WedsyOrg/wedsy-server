// MB-CRM S6 demand map. Run: node tests/venue-crm-dates.test.js
// Reuses existing inventory (VenueEnquiry demand + VenueHold + VenueSpaceDate).
// Asserts contested detection, held countdown, booked, and open inventory.
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueHold = require("../models/VenueHold");
const { getDemandMap } = require("../controllers/venueCrmDates");

const TAG = `mbcrm-s6-${Date.now()}`;
const OWNER = new mongoose.Types.ObjectId();
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const created = { venues: [] };

const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const ownerReq = (venue) => ({ params: { slug: venue.slug }, query: {}, body: {}, venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: OWNER }, venueMember: null });

const CONTESTED = "2027-11-26";
const HELD = "2027-12-14";
const BOOKED = "2026-11-11";

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const venue = await Venue.create({ name: `${TAG}-v`, slug: `${TAG}-v` });
    created.venues.push(venue._id);

    // two leads competing for CONTESTED
    await VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} A`, stage: "new", checkIn: new Date(`${CONTESTED}T10:00:00Z`) });
    await VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} B`, stage: "contacted", checkIn: new Date(`${CONTESTED}T10:00:00Z`) });
    // one lead wanting HELD (so the hold shows competingCount)
    const held = await VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} Held`, stage: "negotiating", checkIn: new Date(`${HELD}T10:00:00Z`) });
    // a booked lead on BOOKED
    await VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} Booked`, stage: "booked", eventDate: new Date(`${BOOKED}T10:00:00Z`) });

    // an active hold on HELD, expiring in ~6 days
    await VenueHold.create({
      venue: venue._id,
      dates: [new Date(`${HELD}T00:00:00Z`)],
      requestedBy: "owner",
      requestedByName: `${TAG} Held`,
      linkedEnquiry: held._id,
      status: "approved",
      expiresAt: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000),
    });

    const res = mockRes();
    await getDemandMap(ownerReq(venue), res);
    ok(res.code === 200, "demand map returns 200");

    const c = (res.body.contested || []).find((x) => x.date === CONTESTED);
    ok(c && c.leadCount === 2, "contested date detected (2 leads competing)");
    ok(c && Array.isArray(c.leads) && c.leads.length === 2, "owner (view_all) sees competing lead names");
    ok(!(res.body.contested || []).some((x) => x.date === HELD), "a date with only ONE lead is not contested");

    const h = (res.body.held || []).find((x) => x.date === HELD);
    ok(h && h.daysLeft >= 5 && h.daysLeft <= 6, "held date shows a live countdown (≈6d left)");
    ok(h && h.couple === `${TAG} Held`, "held card names the couple");

    ok((res.body.booked || []).some((x) => x.date === BOOKED && x.couple === `${TAG} Booked`), "booked date listed with the couple");
    ok(res.body.openInventory && res.body.openInventory.count > 0 && Array.isArray(res.body.openInventory.sample), "open inventory reports empty near-term dates");
  } catch (err) {
    console.error("FATAL", err);
    fail++;
  } finally {
    try {
      const vids = created.venues;
      await VenueEnquiry.deleteMany({ venueId: { $in: vids } });
      await VenueHold.deleteMany({ venue: { $in: vids } });
      await Venue.deleteMany({ _id: { $in: vids } });
    } catch (e) { console.error("cleanup error", e.message); }
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
