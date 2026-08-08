// Site visits — owner-side creation + full lifecycle + the scope leak this
// closes. Run: node tests/venue-site-visits.test.js
//
// The leak: listOwnSiteVisits used to filter on { venue } alone and populate
// coupleName/couplePhone, so a scoped Sales member could read every couple in
// the venue through the visits list (invariant #5). Every read and write now
// resolves the parent lead through venueLeadScope.
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueSiteVisit = require("../models/VenueSiteVisit");
const VenueTeamMember = require("../models/VenueTeamMember");

const sv = require("../controllers/venueSiteVisits");
const T = require("../utils/venueTime");

const TAG = `venue-sv-${Date.now()}`;
const OWNER = new mongoose.Types.ObjectId();
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const created = { venues: [], members: [] };

const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const ownerReq = (venue, extra = {}) => ({ params: { slug: venue.slug, ...(extra.params || {}) }, query: extra.query || {}, body: extra.body || {}, venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: OWNER }, venueMember: null });
const memberReq = (venue, member, extra = {}) => ({ params: { slug: venue.slug, ...(extra.params || {}) }, query: extra.query || {}, body: extra.body || {}, venueOwner: { type: "venue_owner", venueId: venue._id, memberId: member._id, role: member.role }, venueMember: member });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };
const freshLead = (id) => VenueEnquiry.findById(id).lean();

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const venue = await Venue.create({ name: `${TAG}-v`, slug: `${TAG}-v` });
    created.venues.push(venue._id);
    const mk = async (s) => { const m = await VenueTeamMember.create({ venueId: venue._id, ownerId: OWNER, name: `${TAG}-${s}`, phone: `${TAG}${s}`, role: "sales", isActive: true }); created.members.push(m._id); return m; };
    const salesA = await mk("A");
    const salesB = await mk("B"); // owns nothing

    const leadA = await VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} Sharma`, couplePhone: "9000301", stage: "contacted", assignedTo: salesA._id });
    const leadB = await VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} Own`, couplePhone: "9000302", stage: "new", assignedTo: salesB._id });

    // ── create (the route that did not exist) ──
    console.log("\n[create — owner-side scheduling]");
    const when = new Date(T.addVenueDays(new Date(), 2).getTime() + 11 * 3600 * 1000);
    const c = await call(sv.createOwnSiteVisit, ownerReq(venue, { body: { leadId: String(leadA._id), scheduledAt: when.toISOString(), notes: "Wants to see the lawn at sunset" } }));
    ok(c.code === 201, "POST /site-visits → 201 (owners can finally schedule their own walk-throughs)");
    ok(c.body.visit.createdByType === "owner", "recorded as owner-created, distinct from planner-created");
    ok(c.body.visit.status === "scheduled", "starts scheduled");
    ok(c.body.advancedTo === "site_visit_scheduled", "scheduling advances the lead's stage");
    let lead = await freshLead(leadA._id);
    ok(lead.stage === "site_visit_scheduled", "…and the lead really moved");
    ok(lead.activities.some((a) => a.type === "site_visit_scheduled"), "…and it is on the lead's timeline");

    ok((await call(sv.createOwnSiteVisit, ownerReq(venue, { body: { scheduledAt: when.toISOString() } }))).code === 400, "create without a lead → 400");
    ok((await call(sv.createOwnSiteVisit, ownerReq(venue, { body: { leadId: String(leadA._id) } }))).code === 400, "create without a time → 400");
    ok((await call(sv.createOwnSiteVisit, ownerReq(venue, { body: { leadId: String(leadA._id), scheduledAt: "not-a-date" } }))).code === 400, "unparseable time → 400");

    const visitId = String(c.body.visit._id);

    // ── list + buckets ──
    console.log("\n[list]");
    const list = await call(sv.listOwnSiteVisits, ownerReq(venue, { query: {} }));
    ok(list.code === 200 && list.body.visits.length === 1, "list returns the visit");
    ok(list.body.counts.upcoming === 1, "upcoming count is real");
    ok(list.body.visits[0].enquiryRef && list.body.visits[0].enquiryRef.coupleName, "row carries its lead — the visit is never an orphan");
    ok((await call(sv.listOwnSiteVisits, ownerReq(venue, { query: { bucket: "past" } }))).body.visits.length === 0, "past bucket excludes a future visit");
    ok((await call(sv.listOwnSiteVisits, ownerReq(venue, { query: { bucket: "nonsense" } }))).code === 400, "unknown bucket → 400");
    ok((await call(sv.listOwnSiteVisits, ownerReq(venue, { query: { status: "banana" } }))).code === 400, "unknown status → 400");
    ok((await call(sv.listOwnSiteVisits, ownerReq(venue, { query: { leadId: String(leadB._id) } }))).body.visits.length === 0, "leadId filter restricts to that lead");

    // ── reschedule ──
    console.log("\n[reschedule]");
    const newWhen = new Date(T.addVenueDays(new Date(), 4).getTime() + 10 * 3600 * 1000);
    const resched = await call(sv.updateOwnSiteVisit, ownerReq(venue, { params: { visitId }, body: { scheduledAt: newWhen.toISOString() } }));
    ok(resched.code === 200, "reschedule → 200");
    lead = await freshLead(leadA._id);
    ok(lead.activities.some((a) => a.type === "site_visit_rescheduled"), "a reschedule is visible history on the lead, not a silent edit");

    // ── complete ──
    console.log("\n[complete]");
    const done = await call(sv.updateOwnSiteVisit, ownerReq(venue, { params: { visitId }, body: { status: "completed", notes: "Loved the lawn" } }));
    ok(done.code === 200 && done.body.visit.status === "completed", "complete → 200");
    ok(done.body.advancedTo === "site_visit_done", "completing advances the lead to site_visit_done");
    lead = await freshLead(leadA._id);
    ok(lead.stage === "site_visit_done", "…and the lead really moved");
    ok(lead.activities.some((a) => a.type === "site_visit_completed"), "…and the completion is on the timeline");
    ok((await call(sv.updateOwnSiteVisit, ownerReq(venue, { params: { visitId }, body: { scheduledAt: newWhen.toISOString() } }))).code === 409, "rescheduling a completed visit → 409");
    ok((await call(sv.updateOwnSiteVisit, ownerReq(venue, { params: { visitId }, body: {} }))).code === 400, "empty PATCH → 400");

    // ── stage moves are forward-only and never regress a won deal ──
    console.log("\n[stage safety]");
    const bookedLead = await VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} Booked`, stage: "booked", assignedTo: salesA._id });
    const bv = await call(sv.createOwnSiteVisit, ownerReq(venue, { body: { leadId: String(bookedLead._id), scheduledAt: when.toISOString() } }));
    ok(bv.code === 201 && bv.body.advancedTo === null, "scheduling a visit on a BOOKED lead records the visit but never drags the stage backwards");
    ok((await freshLead(bookedLead._id)).stage === "booked", "…the booked lead stays booked");

    // A member who cannot change stage still gets their visit recorded.
    const noStage = await call(sv.createOwnSiteVisit, memberReq(venue, salesB, { body: { leadId: String(leadB._id), scheduledAt: when.toISOString() } }));
    ok(noStage.code === 201, "a scoped member can schedule a visit on their OWN lead");

    // ── DENY SWEEP ──
    console.log("\n[deny-sweep: scoped Sales (owns nothing of leadA) vs leadA's visit]");
    const before = JSON.stringify(await VenueSiteVisit.findById(visitId).lean());

    const dList = await call(sv.listOwnSiteVisits, memberReq(venue, salesB, { query: {} }));
    ok(dList.code === 200, "list → 200");
    ok(!dList.body.visits.some((v) => String(v.enquiryRef && v.enquiryRef._id) === String(leadA._id)),
      "THE LEAK IS CLOSED: another member's lead does not appear in the visits list");
    ok(!JSON.stringify(dList.body).includes("Sharma"), "…and their couple name is nowhere in the payload");
    ok(dList.body.counts.upcoming <= 1, "…and the counts only reflect their own leads");

    const dPatch = await call(sv.updateOwnSiteVisit, memberReq(venue, salesB, { params: { visitId }, body: { status: "cancelled" } }));
    ok(dPatch.code === 404, "updateOwnSiteVisit → 404 (never 403)");
    ok(JSON.stringify(await VenueSiteVisit.findById(visitId).lean()) === before, "…and the write did NOT happen");

    const dDel = await call(sv.deleteOwnSiteVisit, memberReq(venue, salesB, { params: { visitId } }));
    ok(dDel.code === 404, "deleteOwnSiteVisit → 404");
    ok(await VenueSiteVisit.findById(visitId), "…and the visit still exists");

    const dCreate = await call(sv.createOwnSiteVisit, memberReq(venue, salesB, { body: { leadId: String(leadA._id), scheduledAt: when.toISOString() } }));
    ok(dCreate.code === 404, "createOwnSiteVisit against an unseen lead → 404");
    ok((await VenueSiteVisit.countDocuments({ enquiryRef: leadA._id })) === 1, "…and no visit was created");

    // ── soft-deleted leads take their visits with them ──
    console.log("\n[soft-delete]");
    await VenueEnquiry.updateOne({ _id: leadA._id }, { $set: { deleted: true, deletedAt: new Date() } });
    const afterDel = await call(sv.listOwnSiteVisits, ownerReq(venue, { query: {} }));
    ok(!afterDel.body.visits.some((v) => String(v._id) === visitId), "a soft-deleted lead's visits vanish from the list");
    ok((await call(sv.updateOwnSiteVisit, ownerReq(venue, { params: { visitId }, body: { status: "confirmed" } }))).code === 404,
      "…and are unreachable by direct id, even for the owner");

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error("FATAL", err);
    fail++;
  } finally {
    for (const v of created.venues) {
      const leads = await VenueEnquiry.find({ venueId: v }).select("_id").lean();
      await VenueSiteVisit.deleteMany({ enquiryRef: { $in: leads.map((l) => l._id) } });
      await VenueEnquiry.deleteMany({ venueId: v });
      await Venue.deleteOne({ _id: v });
    }
    await VenueTeamMember.deleteMany({ _id: { $in: created.members } });
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
