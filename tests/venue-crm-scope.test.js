// MB-CRM review fix — per-route DENY SWEEP (no sibling inference). Run:
//   node tests/venue-crm-scope.test.js
// As a scoped Sales member who owns NO leads, hit EVERY lead-resolving route by
// direct id against another member's lead and assert 404/skip AND that the write
// did not happen (re-read the target and confirm unchanged). Plus: leads_delete
// soft-delete + exclusion, quick-log respects leads_change_stage, demand-map
// name gating.
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueTeamMember = require("../models/VenueTeamMember");
const VenueRole = require("../models/VenueRole");
const VenueLeadInteraction = require("../models/VenueLeadInteraction");
const VenueHold = require("../models/VenueHold");

const enq = require("../controllers/venueEnquiry");
const inter = require("../controllers/venueLeadInteraction");
const bulk = require("../controllers/venueBulk");
const tasks = require("../controllers/venueTask");
const dates = require("../controllers/venueCrmDates");
const wa = require("../utils/venueWhatsApp");

const TAG = `mbcrm-scope-${Date.now()}`;
const OWNER = new mongoose.Types.ObjectId();
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const created = { venues: [], members: [], roles: [] };

const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const memberReq = (venue, member, extra = {}) => ({ params: { slug: venue.slug, ...(extra.params || {}) }, query: extra.query || {}, body: extra.body || {}, venueOwner: { type: "venue_owner", venueId: venue._id, memberId: member._id, role: member.role }, venueMember: member });
const ownerReq = (venue, extra = {}) => ({ params: { slug: venue.slug, ...(extra.params || {}) }, query: extra.query || {}, body: extra.body || {}, venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: OWNER }, venueMember: null });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const venue = await Venue.create({ name: `${TAG}-v`, slug: `${TAG}-v` });
    created.venues.push(venue._id);
    const mk = async (s, extra = {}) => { const m = await VenueTeamMember.create({ venueId: venue._id, ownerId: OWNER, name: `${TAG}-${s}`, phone: `${TAG}${s}`, role: "sales", isActive: true, ...extra }); created.members.push(m._id); return m; };

    const salesA = await mk("A"); // owns leadA
    const salesB = await mk("B"); // owns NOTHING — the scoped attacker

    const leadA = await VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} Sharma`, couplePhone: "9000001", stage: "contacted", followUpNote: "orig", assignedTo: salesA._id });
    const p = { enquiryId: String(leadA._id) };
    const freshA = () => VenueEnquiry.findById(leadA._id).lean();
    const interCount = () => VenueLeadInteraction.countDocuments({ enquiry: leadA._id });

    console.log("\n[deny-sweep: scoped Sales (owns nothing) vs another member's lead by direct id]");

    // updateEnquiry
    const before = await freshA();
    const upd = await call(enq.updateEnquiry, memberReq(venue, salesB, { params: p, body: { stage: "site_visit_scheduled", addNote: "sneaky", followUpNote: "hacked" } }));
    const afterUpd = await freshA();
    ok(upd.code === 404, "updateEnquiry → 404");
    ok(afterUpd.stage === before.stage && afterUpd.followUpNote === "orig" && (afterUpd.notes || []).length === 0, "updateEnquiry wrote NOTHING (stage/note/followUpNote unchanged)");

    // quickLog
    const icBefore = await interCount();
    const ql = await call(inter.quickLog, memberReq(venue, salesB, { params: p, body: { type: "call", note: "x" } }));
    ok(ql.code === 404, "quickLog → 404");
    ok((await interCount()) === icBefore && (await freshA()).stage === before.stage, "quickLog logged NOTHING and did not advance stage");

    // addInteraction / getInteractions
    const ai = await call(inter.addInteraction, memberReq(venue, salesB, { params: p, body: { type: "call" } }));
    ok(ai.code === 404 && (await interCount()) === icBefore, "addInteraction → 404, no interaction written");
    const gi = await call(inter.getInteractions, memberReq(venue, salesB, { params: p }));
    ok(gi.code === 404, "getInteractions → 404");

    // deleteEnquiry (scoped resolve; salesB can't even see it)
    const del = await call(enq.deleteEnquiry, memberReq(venue, salesB, { params: p }));
    ok(del.code === 404 && (await freshA()).deleted === false, "deleteEnquiry → 404, lead NOT deleted");

    // bulkAction
    const ba = await call(bulk.bulkAction, memberReq(venue, salesB, { body: { enquiryIds: [String(leadA._id)], action: "stage", value: "booked" } }));
    ok(ba.code === 200 && ba.body.updated === 0 && ba.body.skipped === 1, "bulkAction skips the out-of-scope id (updated 0, skipped 1)");
    ok((await freshA()).stage === before.stage, "bulkAction wrote nothing to the lead");

    // bulkWhatsApp (stub the WA client so we reach the loop)
    wa.isConfigured = () => true;
    wa.sendText = async () => ({ ok: true });
    const bw = await call(bulk.bulkWhatsApp, memberReq(venue, salesB, { body: { enquiryIds: [String(leadA._id)], body: "hi" } }));
    ok(bw.code === 200 && bw.body.sent === 0 && bw.body.skipped === 1, "bulkWhatsApp skips the out-of-scope id (sent 0, skipped 1)");
    ok((await interCount()) === icBefore, "bulkWhatsApp logged no interaction on the lead");

    // task link
    const tl = await call(tasks.createTask, memberReq(venue, salesB, { body: { title: `${TAG} t`, linkedEnquiry: String(leadA._id) } }));
    ok(tl.code === 404, "createTask linking an unseen lead → 404");

    // ── positive control: owner CAN act on the same lead ──
    console.log("\n[positive control + soft-delete]");
    const ownerUpd = await call(enq.updateEnquiry, ownerReq(venue, { params: p, body: { addNote: "real note" } }));
    ok(ownerUpd.code === 200, "owner CAN update the lead");

    // ── quick-log respects leads_change_stage ──
    const leadsOnly = await VenueRole.create({ venue: venue._id, name: `${TAG}-leadsonly`, capabilities: ["leads"] });
    created.roles.push(leadsOnly._id);
    const restricted = await VenueTeamMember.create({ venueId: venue._id, ownerId: OWNER, name: `${TAG}-R`, phone: `${TAG}R`, role: "sales", roleRef: leadsOnly._id, isActive: true });
    created.members.push(restricted._id);
    const leadR = await VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} Own`, couplePhone: "9000009", stage: "new", assignedTo: restricted._id });
    const qlR = await call(inter.quickLog, memberReq(venue, restricted, { params: { enquiryId: String(leadR._id) }, body: { type: "call" } }));
    ok(qlR.code === 201 && qlR.body.advancedTo === null, "quick-log on OWN lead logs, but a leads-only member does NOT auto-advance (no leads_change_stage)");
    ok((await VenueLeadInteraction.countDocuments({ enquiry: leadR._id })) === 1, "the interaction WAS logged (advance skipped, not 403)");

    // ── demand-map name gating ──
    await VenueHold.create({ venue: venue._id, dates: [new Date("2027-12-14T00:00:00Z")], requestedBy: "owner", requestedByName: `${TAG} Sharma`, linkedEnquiry: leadA._id, status: "approved", expiresAt: new Date(Date.now() + 6 * 86400000) });
    const dOwner = await call(dates.getDemandMap, ownerReq(venue));
    const heldOwner = (dOwner.body.held || []).find((h) => h.date === "2027-12-14");
    ok(heldOwner && heldOwner.couple === `${TAG} Sharma`, "owner sees the real couple name on a held date");
    const dSales = await call(dates.getDemandMap, memberReq(venue, salesB));
    const heldSales = (dSales.body.held || []).find((h) => h.date === "2027-12-14");
    ok(heldSales && heldSales.couple === "A couple", "scoped Sales sees the held DATE but the couple NAME is gated");
    ok((dSales.body.contested || []).length === 0, "scoped Sales's contested map is built only from their own (zero) leads");

    // ── owner soft-delete → excluded from every query ──
    const ownerDel = await call(enq.deleteEnquiry, ownerReq(venue, { params: p }));
    ok(ownerDel.code === 200 && (await freshA()).deleted === true, "owner soft-deletes the lead (flagged, not removed)");
    const listAfter = await call(enq.getVenueEnquiries, ownerReq(venue));
    ok(!listAfter.body.enquiries.some((e) => String(e._id) === String(leadA._id)), "a soft-deleted lead is excluded from the list");
    const readAfter = await call(enq.getEnquiryById, ownerReq(venue, { params: p }));
    ok(readAfter.code === 404, "a soft-deleted lead 404s on single-read");
  } catch (err) {
    console.error("FATAL", err);
    fail++;
  } finally {
    try {
      const vids = created.venues;
      await VenueEnquiry.deleteMany({ venueId: { $in: vids } });
      await VenueLeadInteraction.deleteMany({ venue: { $in: vids } });
      await VenueHold.deleteMany({ venue: { $in: vids } });
      await VenueTeamMember.deleteMany({ _id: { $in: created.members } });
      await VenueRole.deleteMany({ venue: { $in: vids } });
      await Venue.deleteMany({ _id: { $in: vids } });
    } catch (e) { console.error("cleanup error", e.message); }
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
