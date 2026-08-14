// BUILD3 S1 — date contention. Run:  node tests/venue-contention.test.js
//
//   A. the lead read's contention summary — excludes self, terminal and
//      soft-deleted leads, and reports the furthest-along stage.
//   B. multi-day: a 30 Sep → 1 Oct block contends on BOTH days, and the
//      headline is the WORST day, not the sum.
//   C. approximate-month demand stays its OWN signal, never folded in.
//   D. SCOPING: a scoped member sees the COUNT and STAGE but no names, ids or
//      money for leads outside their scope.
//   E. the day endpoint: rows scoped, hiddenCount honest, hold/booking/
//      auspicious state present.
//   F. DENY SWEEP on the new read surface by direct id, with
//      write-didn't-happen asserted.
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
const VenueSiteVisit = require("../models/VenueSiteVisit");
const VenueLeadInteraction = require("../models/VenueLeadInteraction");
const AuspiciousDate = require("../models/AuspiciousDate");

const enq = require("../controllers/venueEnquiry");
const day = require("../controllers/venueCrmDay");
const { toDayStart } = require("../utils/auspiciousDates");

const TAG = `venue-cont-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const created = { venues: [], owners: [], auspicious: [] };

const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };

// 2026-11-26 IST — the contested date. Times are chosen so the venue-day key
// is unambiguous in Asia/Kolkata.
const D = (iso) => new Date(iso);

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const venue = await Venue.create({ name: `${TAG}-v`, slug: `${TAG}-v`, state: "Karnataka", city: "Bengaluru", spaces: [{ name: "Lawn", isBookable: true }] });
    created.venues.push(venue._id);
    const ownerDoc = await VenueOwner.create({ venueId: venue._id, name: "Owner", phone: `${TAG}o`, isActive: true });
    created.owners.push(ownerDoc._id);
    const OWNER = ownerDoc._id;
    const sales = await VenueTeamMember.create({ venueId: venue._id, ownerId: OWNER, name: "Sales Sam", phone: `${TAG}s`, role: "sales", isActive: true });
    const other = await VenueTeamMember.create({ venueId: venue._id, ownerId: OWNER, name: "Other Olive", phone: `${TAG}x`, role: "sales", isActive: true });

    const ownerReq = (extra = {}) => ({
      params: { slug: venue.slug, ...(extra.params || {}) }, query: extra.query || {}, body: extra.body || {},
      venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: OWNER }, venueMember: null,
    });
    // A Sales member WITHOUT leads_view_all.
    const salesReq = (extra = {}) => ({
      params: { slug: venue.slug, ...(extra.params || {}) }, query: extra.query || {}, body: extra.body || {},
      venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: OWNER, memberId: sales._id, role: "sales" },
      venueMember: sales,
    });

    const mk = (name, phone, checkIn, checkOut, stage, extra = {}) =>
      VenueEnquiry.create({ venueId: venue._id, coupleName: name, couplePhone: phone, checkIn: D(checkIn), checkOut: checkOut ? D(checkOut) : undefined, stage, ...extra });

    // ── A. the summary ──
    console.log("\n[A. the lead read answers 'who else wants this date?']");
    const mine = await mk(`${TAG} Mine`, "9000001", "2026-11-26T10:30:00Z", "2026-11-27T05:00:00Z", "contacted", { assignedTo: sales._id });
    const rivalA = await mk(`${TAG} Rival A`, "9000002", "2026-11-26T10:30:00Z", null, "negotiating", { assignedTo: other._id });
    const rivalB = await mk(`${TAG} Rival B`, "9000003", "2026-11-26T12:00:00Z", null, "new", { assignedTo: other._id });
    const rivalC = await mk(`${TAG} Rival C`, "9000004", "2026-11-26T12:00:00Z", null, "proposal_sent", { assignedTo: sales._id });
    // Excluded: terminal + soft-deleted, both on the same date.
    await mk(`${TAG} Lost`, "9000005", "2026-11-26T12:00:00Z", null, "lost");
    await mk(`${TAG} Booked`, "9000006", "2026-11-26T12:00:00Z", null, "booked");
    const deleted = await mk(`${TAG} Deleted`, "9000007", "2026-11-26T12:00:00Z", null, "contacted");
    await VenueEnquiry.updateOne({ _id: deleted._id }, { $set: { deleted: true, deletedAt: new Date() } });

    const read = await call(enq.getEnquiryById, ownerReq({ params: { enquiryId: String(mine._id) } }));
    ok(read.code === 200, "lead read → 200");
    const c = read.body.enquiry.contention;
    ok(c && c.count === 3, `3 other live leads want the date (got ${c && c.count})`);
    ok(c.topStage === "negotiating", "…and the furthest-along among them is reported");
    ok(!JSON.stringify(c).includes("Rival"), "THE POINT: the summary carries NO names — it is a count and a stage");
    ok(c.date === "2026-11-26", "…and names the day the client should link to");

    const selfRead = await call(enq.getEnquiryById, ownerReq({ params: { enquiryId: String(rivalB._id) } }));
    ok(selfRead.body.enquiry.contention.count === 3, "each lead's count excludes ITSELF (3, not 4)");

    // ── B. multi-day ──
    console.log("\n[B. a multi-day block contends on every day it occupies]");
    // `mine` spans 26→27 Nov. Give 27 Nov a single rival: 26 Nov stays worst.
    await mk(`${TAG} Rival D`, "9000008", "2026-11-27T10:30:00Z", null, "contacted", { assignedTo: other._id });
    const multi = await call(enq.getEnquiryById, ownerReq({ params: { enquiryId: String(mine._id) } }));
    const mc = multi.body.enquiry.contention;
    ok(mc.days.length === 2, "both days of the block are reported as contested");
    ok(mc.days.some((d) => d.date === "2026-11-27" && d.count === 1), "…including the second day");
    ok(mc.count === 3 && mc.date === "2026-11-26", "the HEADLINE is the worst day (3 on 26 Nov), not the sum of 4");
    ok(mc.totalLeads === 4, "…while totalLeads still reports the distinct leads across the whole block");

    // ── C. approximate month stays separate ──
    console.log("\n[C. 'N want this month' is demand, not contention]");
    await VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} Undecided 1`, datesFinalised: false, approximatePeriod: { month: 11, year: 2026 }, stage: "new" });
    await VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} Undecided 2`, datesFinalised: false, approximatePeriod: { month: 11, year: 2026 }, stage: "contacted" });
    const withMonth = await call(enq.getEnquiryById, ownerReq({ params: { enquiryId: String(mine._id) } }));
    ok(withMonth.body.enquiry.approximateDemand.count === 2, "2 unfinalised leads name November");
    ok(withMonth.body.enquiry.approximateDemand.month === "2026-11", "…reported as its own month signal");
    ok(withMonth.body.enquiry.contention.count === 3, "…and contention is UNCHANGED by them — nobody is competing for a day nobody named");

    // ── D. scoping ──
    console.log("\n[D. a scoped member sees the number, never the names]");
    const scopedRead = await call(enq.getEnquiryById, salesReq({ params: { enquiryId: String(mine._id) } }));
    ok(scopedRead.code === 200, "a scoped member can read their OWN lead");
    const sc = scopedRead.body.enquiry.contention;
    ok(sc && sc.count === 3, "THE DECISION: they see the full venue-wide count (3), not a scoped 1");
    ok(sc.topStage === "negotiating", "…and the furthest-along stage, which is the useful half");
    ok(!JSON.stringify(sc).includes("Rival") && !JSON.stringify(sc).includes(String(rivalA._id)),
      "…but no names and no ids of leads outside their scope");
    ok(scopedRead.body.enquiry.contentionScoped === true, "…and the payload says it is scoped so the UI can hide 'open lead'");

    const foreign = await call(enq.getEnquiryById, salesReq({ params: { enquiryId: String(rivalA._id) } }));
    ok(foreign.code === 404, "reading another member's lead by direct id is still 404 (never 403)");

    // ── E. the day endpoint ──
    console.log("\n[E. the day endpoint: everything happening on 26 Nov]");
    await AuspiciousDate.create({ date: toDayStart("2026-11-26"), year: 2026, month: 11, day: 26, region: null, tier: "major", notes: "Peak" });
    created.auspicious.push("2026-11-26");
    await VenueSiteVisit.create({ venue: venue._id, enquiryRef: rivalC._id, scheduledAt: D("2026-09-01T05:00:00Z"), status: "completed" });
    const hold = await VenueHold.create({ venue: venue._id, dates: [toDayStart("2026-11-26")], requestedBy: "owner", requestedByName: "Rival A", linkedEnquiry: rivalA._id, status: "approved", expiresAt: new Date(Date.now() + 7 * 86400000) });

    const ownerDay = await call(day.getDay, ownerReq({ query: { date: "2026-11-26", from: String(mine._id) } }));
    ok(ownerDay.code === 200, "day endpoint → 200");
    ok(ownerDay.body.total === 4, "every non-terminal lead wanting the day is counted (4 incl. the one we came from)");
    ok(ownerDay.body.leads.length === 4, "…and the owner sees all four rows");
    ok(ownerDay.body.leads[0].isThisLead === true, "the lead we came FROM is marked and sorted first");
    ok(ownerDay.body.leads.every((l) => !/Lost|Booked|Deleted/.test(l.coupleName)), "terminal and soft-deleted leads appear nowhere");
    const cRow = ownerDay.body.leads.find((l) => /Rival C/.test(l.coupleName));
    ok(cRow.siteVisitStatus === "completed", "site-visit status rides along");
    ok(cRow.assignedTo && cRow.assignedTo.name === "Sales Sam", "…as does the owner of each lead");
    ok(ownerDay.body.holds.length === 1 && String(ownerDay.body.holds[0]._id) === String(hold._id), "the hold on the date is reported");
    ok(ownerDay.body.auspicious && ownerDay.body.auspicious.tier === "major", "the auspicious flag comes from the live helper, not a re-derived rule");
    ok(ownerDay.body.approximateDemand.count === 2, "'2 more want this month' rides along too");
    ok(ownerDay.body.hiddenCount === 0, "nothing is hidden from an owner");

    const salesDay = await call(day.getDay, salesReq({ query: { date: "2026-11-26" } }));
    ok(salesDay.code === 200, "a scoped member may open the day view");
    ok(salesDay.body.total === 4, "…and is told the true total (4)");
    ok(salesDay.body.leads.length === 2, "…but only gets rows for the 2 leads they could already open");
    ok(salesDay.body.hiddenCount === 2, "…with the remainder counted, not named");
    ok(!JSON.stringify(salesDay.body.leads).includes("Rival A") && !JSON.stringify(salesDay.body.leads).includes("Rival B"),
      "THE POINT: no name of a lead outside their scope appears anywhere in the rows");
    ok(salesDay.body.holds[0].couple === "A couple" && salesDay.body.holds[0].linkedEnquiry === undefined,
      "…and a hold on someone else's lead is de-identified rather than dropped");
    ok(salesDay.body.scoped === true, "the payload declares itself scoped");

    // ── F. deny sweep ──
    console.log("\n[F. deny sweep on the new read surface]");
    const otherVenue = await Venue.create({ name: `${TAG}-v2`, slug: `${TAG}-v2` });
    created.venues.push(otherVenue._id);
    const crossVenue = await call(day.getDay, {
      params: { slug: otherVenue.slug }, query: { date: "2026-11-26" }, body: {},
      venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: OWNER }, venueMember: null,
    });
    ok(crossVenue.code === 403, "a token for venue A cannot read venue B's day");
    const badDate = await call(day.getDay, ownerReq({ query: { date: "not-a-date" } }));
    ok(badDate.code === 400, "a malformed date is refused, not coerced");
    const noDate = await call(day.getDay, ownerReq({ query: {} }));
    ok(noDate.code === 400, "a missing date is refused");

    // write-didn't-happen: the day endpoint is a READ and must mutate nothing.
    const before = await VenueEnquiry.find({ venueId: venue._id }).select("_id updatedAt stage").sort({ _id: 1 }).lean();
    const holdBefore = await VenueHold.findById(hold._id).lean();
    await call(day.getDay, salesReq({ query: { date: "2026-11-26" } }));
    await call(day.getDay, ownerReq({ query: { date: "2026-11-26" } }));
    const after = await VenueEnquiry.find({ venueId: venue._id }).select("_id updatedAt stage").sort({ _id: 1 }).lean();
    ok(JSON.stringify(before) === JSON.stringify(after), "WRITE-DIDN'T-HAPPEN: no lead was touched by the day reads");
    const holdAfter = await VenueHold.findById(hold._id).lean();
    ok(holdBefore.status === holdAfter.status && String(holdBefore.updatedAt) === String(holdAfter.updatedAt), "…and no hold was touched either");

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
      await VenueSiteVisit.deleteMany({ venue: v });
      await VenueTask.deleteMany({ venue: v });
      await VenueHold.deleteMany({ venue: v });
      await VenueBooking.deleteMany({ venue: v });
      await VenueEnquiry.deleteMany({ venueId: v });
      await VenueTeamMember.deleteMany({ venueId: v });
      await Venue.deleteOne({ _id: v });
    }
    for (const k of created.auspicious) await AuspiciousDate.deleteOne({ date: toDayStart(k), region: null });
    await VenueOwner.deleteMany({ _id: { $in: created.owners } });
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
