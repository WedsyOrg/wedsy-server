// Venue day boundaries are IST, not server-local. Run:
//   node tests/venue-time-ist.test.js
// The bug this locks down: on a UTC box, between 00:00 and 05:30 IST the Indian
// calendar day has advanced but UTC has not, so "due today" reads as tomorrow
// and yesterday's miss is not yet "overdue". Pure-unit section runs with no DB;
// the controller section proves the CRM dashboard buckets by the venue day.
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const { getCrmOverview } = require("../controllers/venueCrmDashboard");
const T = require("../utils/venueTime");

const TAG = `venue-tz-${Date.now()}`;
const OWNER = new mongoose.Types.ObjectId();
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const created = { venues: [] };

const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const ownerReq = (venue) => ({ params: { slug: venue.slug }, query: {}, body: {}, venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: OWNER }, venueMember: null });

(async () => {
  try {
    console.log("\n[unit: IST day boundaries]");

    // 00:30 IST on 10 Aug = 19:00 UTC on 9 Aug — inside the broken window.
    const inWindow = new Date("2026-08-09T19:00:00Z");
    ok(T.venueDateKey(inWindow) === "2026-08-10", "00:30 IST resolves to the 10th, not the 9th");
    ok(T.startOfVenueDay(inWindow).toISOString() === "2026-08-09T18:30:00.000Z", "venue day starts at 18:30 UTC (00:00 IST)");
    ok(T.endOfVenueDay(inWindow).toISOString() === "2026-08-10T18:29:59.999Z", "venue day ends at 18:29:59.999 UTC");

    // The buckets that were wrong for 5h30m a day.
    ok(T.venueDueBucket(new Date("2026-08-10T00:00:00Z"), inWindow) === "today", "a follow-up dated the 10th is DUE TODAY at 00:30 IST on the 10th");
    ok(T.venueDueBucket(new Date("2026-08-09T00:00:00Z"), inWindow) === "overdue", "a follow-up dated the 9th is already OVERDUE at 00:30 IST on the 10th");
    ok(T.venueDueBucket(new Date("2026-08-11T00:00:00Z"), inWindow) === "tomorrow", "the 11th is tomorrow");
    ok(T.venueDueBucket(new Date("2026-08-15T00:00:00Z"), inWindow) === "this_week", "the 15th is this week");
    ok(T.venueDueBucket(new Date("2026-09-15T00:00:00Z"), inWindow) === "later", "a month out is later");
    ok(T.venueDueBucket(null, inWindow) === null && T.venueDueBucket("nonsense", inWindow) === null, "null / unparseable → no bucket (never a false 'overdue')");

    // The real property: the answer must not depend on the box's TZ. Prod runs
    // UTC, this laptop runs IST — both must agree. Child processes, since Node
    // caches the zone at startup.
    const { execFileSync } = require("child_process");
    const probe = "const T=require('./utils/venueTime');" +
      "process.stdout.write(T.startOfVenueDay(new Date('2026-08-09T19:00:00Z')).toISOString()+'|'+T.venueDateKey(new Date('2026-08-09T19:00:00Z')));";
    const underTz = (tz) => execFileSync(process.execPath, ["-e", probe], { cwd: require("path").join(__dirname, ".."), env: { ...process.env, TZ: tz } }).toString();
    const utcBox = underTz("UTC");
    const nycBox = underTz("America/New_York");
    const istBox = underTz("Asia/Kolkata");
    ok(utcBox === "2026-08-09T18:30:00.000Z|2026-08-10", `a UTC box (prod) computes the IST day correctly — got ${utcBox}`);
    ok(utcBox === nycBox && utcBox === istBox, "UTC / New York / IST boxes all agree — the process TZ cannot change the answer");

    // Midday is unambiguous in both schemes — the fix must not move it.
    const midday = new Date("2026-08-10T06:30:00Z"); // 12:00 IST
    ok(T.venueDateKey(midday) === "2026-08-10", "midday IST is unambiguous");
    ok(T.venueDayDiff(new Date("2026-08-13T00:00:00Z"), midday) === 3, "day diff counts calendar days, not 24h blocks");
    ok(T.addVenueDays(midday, 3).toISOString() === "2026-08-12T18:30:00.000Z", "addVenueDays lands on IST midnight of the +3 day");

    // No DST in India, but the helper must be stable across a year boundary.
    const nye = new Date("2026-12-31T19:30:00Z"); // 01:00 IST, 1 Jan 2027
    ok(T.venueDateKey(nye) === "2027-01-01", "year rolls over on IST midnight, not UTC midnight");

    console.log("\n[controller: CRM dashboard buckets by the venue day]");
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const venue = await Venue.create({ name: `${TAG}-v`, slug: `${TAG}-v` });
    created.venues.push(venue._id);

    // Anchor to the real venue day so the assertions hold whenever this runs.
    const todayStart = T.startOfVenueDay();
    await VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} DueToday`, stage: "contacted", followUpDate: new Date(todayStart.getTime() + 6 * 3600 * 1000) });
    await VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} JustOverdue`, stage: "contacted", followUpDate: new Date(todayStart.getTime() - 1000) });
    await VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} Tomorrow`, stage: "contacted", followUpDate: T.addVenueDays(new Date(), 1) });

    const res = mockRes();
    await getCrmOverview(ownerReq(venue), res);
    ok(res.code === 200, "overview 200s");
    ok(res.body.myDay.dueToday === 1, "exactly the lead inside the venue day counts as due today");
    ok(res.body.myDay.overdue === 1, "a follow-up 1ms before venue midnight is overdue");
    ok(res.body.myDay.dueToday + res.body.myDay.overdue === 2, "tomorrow's lead is in neither bucket");

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error("FATAL", err);
    fail++;
  } finally {
    for (const v of created.venues) {
      await VenueEnquiry.deleteMany({ venueId: v });
      await Venue.deleteOne({ _id: v });
    }
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
