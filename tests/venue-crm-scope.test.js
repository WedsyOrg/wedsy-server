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
const VenueQuote = require("../models/VenueQuote");
const VenueTask = require("../models/VenueTask");
const VenueBooking = require("../models/VenueBooking");

const enq = require("../controllers/venueEnquiry");
const inter = require("../controllers/venueLeadInteraction");
const bulk = require("../controllers/venueBulk");
const tasks = require("../controllers/venueTask");
const dates = require("../controllers/venueCrmDates");
const quotes = require("../controllers/venueQuote");
const calendar = require("../controllers/venueCalendar");
const analytics = require("../controllers/venueAnalytics");
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

    // ── quote/doc scope bypass: enquiry reads now route through resolveScopedEnquiry ──
    console.log("\n[deny-sweep: quote routes vs another member's lead by direct id]");

    // createQuote (venueQuote.js:29) — must not surface/quote an unseen lead.
    const quotesBefore = await VenueQuote.countDocuments({ venue: venue._id });
    const cq = await call(quotes.createQuote, memberReq(venue, salesB, { body: { enquiry: String(leadA._id), lineItems: [{ label: "x", category: "venue_hire", qty: 1, unitPrice: 100 }] } }));
    ok(cq.code === 404, "createQuote for an unseen lead → 404");
    ok((await VenueQuote.countDocuments({ venue: venue._id })) === quotesBefore, "createQuote wrote NO quote for the out-of-scope lead");

    // Seed an accepted quote (owner-side) so we can probe the accept/confirm paths.
    const ownerQuote = await VenueQuote.create({ venue: venue._id, enquiry: leadA._id, version: 1, status: "accepted", lineItems: [{ label: "hire", category: "venue_hire", qty: 1, unitPrice: 500 }], totals: { subtotal: 500, taxable: 500, gst: 90, grandTotal: 590 } });
    const qp = { quoteId: String(ownerQuote._id) };

    // confirmBookingFromQuote (venueQuote.js:159) — enquiry now scoped → 404, no booking.
    const bookingsBefore = await VenueBooking.countDocuments({ venue: venue._id });
    const cb = await call(quotes.confirmBookingFromQuote, memberReq(venue, salesB, { params: qp }));
    ok(cb.code === 404, "confirmBookingFromQuote on an unseen lead's quote → 404");
    ok((await VenueBooking.countDocuments({ venue: venue._id })) === bookingsBefore, "confirmBookingFromQuote created NO booking from the out-of-scope lead");

    // updateQuote accepted-path (venueQuote.js:136) — enquiry scoped → booking stays null.
    const uq = await call(quotes.updateQuote, memberReq(venue, salesB, { params: qp, body: { status: "accepted" } }));
    ok(uq.code === 200 && uq.body.booking === null, "updateQuote→accepted on an unseen lead yields NO booking (enquiry out of scope)");
    ok((await VenueBooking.countDocuments({ venue: venue._id })) === bookingsBefore, "updateQuote still created NO booking from the out-of-scope lead");

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

    // ── soft-delete must not leak through linked tasks or calendar/analytics counts ──
    console.log("\n[soft-delete leak: task populate + calendar/analytics counts]");

    // Task list: link a task to a live lead, then soft-delete the lead. The task
    // survives but its populated linkedEnquiry must be nulled (coupleName/stage gone).
    const leadT = await VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} Linked`, couplePhone: "9000010", stage: "contacted" });
    const mkTask = await call(tasks.createTask, ownerReq(venue, { body: { title: `${TAG} linked-task`, linkedEnquiry: String(leadT._id) } }));
    ok(mkTask.code === 201, "owner links a task to a live lead");
    const taskId = mkTask.body.task._id;
    await VenueEnquiry.updateOne({ _id: leadT._id }, { deleted: true, deletedAt: new Date() });
    const taskList = await call(tasks.listTasks, ownerReq(venue, { query: { filter: "all" } }));
    const linkedRow = (taskList.body.tasks || []).find((t) => String(t._id) === String(taskId));
    ok(!!linkedRow, "the task itself still lists after its lead is soft-deleted");
    ok(linkedRow && linkedRow.linkedEnquiry == null, "the soft-deleted lead does NOT surface coupleName/stage through the task list (link nulled)");

    // Calendar holds: a requested hold links a live lead, then the lead is
    // soft-deleted (holds don't release on delete). getCalendar's populate must
    // null the link so the hold no longer surfaces the lead's coupleName/stage.
    const leadH = await VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} Held`, couplePhone: "9000012", stage: "contacted" });
    await VenueHold.create({ venue: venue._id, dates: [new Date("2027-06-20T00:00:00Z")], requestedBy: "owner", requestedByName: `${TAG} Held`, linkedEnquiry: leadH._id, status: "requested", expiresAt: new Date(Date.now() + 6 * 86400000) });
    const findHoldEntry = (calRes) => {
      const day = (calRes.body.days || []).find((d) => d.date === "2027-06-20");
      return day && (day.pendingHolds || []).find((h) => String(h.linkedEnquiry && (h.linkedEnquiry._id || h.linkedEnquiry)) === String(leadH._id) || (h.requestedByName === `${TAG} Held`));
    };
    const calBefore = await call(calendar.getCalendar, ownerReq(venue, { query: { month: "2027-06" } }));
    const holdBefore = findHoldEntry(calBefore);
    ok(holdBefore && holdBefore.linkedEnquiry && holdBefore.linkedEnquiry.coupleName === `${TAG} Held`, "calendar hold surfaces the live lead's coupleName before delete");
    await VenueEnquiry.updateOne({ _id: leadH._id }, { deleted: true, deletedAt: new Date() });
    const calAfter = await call(calendar.getCalendar, ownerReq(venue, { query: { month: "2027-06" } }));
    const holdAfter = findHoldEntry(calAfter);
    ok(!!holdAfter, "the hold itself still appears on the calendar after its lead is soft-deleted");
    ok(holdAfter && holdAfter.linkedEnquiry == null, "the soft-deleted lead does NOT surface coupleName/stage through the calendar hold (link nulled)");

    // Calendar + analytics: a booked lead with an event date counts until soft-deleted.
    const leadD = await VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} Booked`, couplePhone: "9000011", stage: "booked", eventDate: new Date("2027-06-15T00:00:00Z") });
    const demandBefore = await call(calendar.demandHeat, ownerReq(venue, { query: { month: "2027-06" } }));
    const bucketBefore = (demandBefore.body.demand || []).find((d) => d.date === "2027-06-15");
    ok(bucketBefore && bucketBefore.leads === 1, "demand heat counts the booked lead before delete");
    const anaBefore = await call(analytics.getAnalytics, ownerReq(venue));
    const totalBefore = anaBefore.body.total;
    const bookedBefore = anaBefore.body.funnel.booked;

    await VenueEnquiry.updateOne({ _id: leadD._id }, { deleted: true, deletedAt: new Date() });

    const demandAfter = await call(calendar.demandHeat, ownerReq(venue, { query: { month: "2027-06" } }));
    const bucketAfter = (demandAfter.body.demand || []).find((d) => d.date === "2027-06-15");
    ok(!bucketAfter, "a soft-deleted booked lead disappears from the demand heat");
    const anaAfter = await call(analytics.getAnalytics, ownerReq(venue));
    ok(anaAfter.body.total === totalBefore - 1, "analytics total drops by one after soft-delete");
    ok(anaAfter.body.funnel.booked === bookedBefore - 1, "analytics booked count drops by one after soft-delete");
  } catch (err) {
    console.error("FATAL", err);
    fail++;
  } finally {
    try {
      const vids = created.venues;
      await VenueEnquiry.deleteMany({ venueId: { $in: vids } });
      await VenueLeadInteraction.deleteMany({ venue: { $in: vids } });
      await VenueHold.deleteMany({ venue: { $in: vids } });
      await VenueQuote.deleteMany({ venue: { $in: vids } });
      await VenueTask.deleteMany({ venue: { $in: vids } });
      await VenueBooking.deleteMany({ venue: { $in: vids } });
      await VenueTeamMember.deleteMany({ _id: { $in: created.members } });
      await VenueRole.deleteMany({ venue: { $in: vids } });
      await Venue.deleteMany({ _id: { $in: vids } });
    } catch (e) { console.error("cleanup error", e.message); }
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
