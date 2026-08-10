// Follow-ups module — full lifecycle + the mirror contract + a deny sweep on
// EVERY new surface. Run: node tests/venue-followups.test.js
//
// The module is the source of truth; VenueEnquiry.followUpDate/.followUpNote
// are a mirror of the next OPEN row. The two must never diverge, because every
// pre-existing consumer (dashboards, digest, list rows, heat colour) reads the
// mirror while the Follow-ups view reads the rows.
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueFollowUp = require("../models/VenueFollowUp");
const VenueTeamMember = require("../models/VenueTeamMember");
const VenueRole = require("../models/VenueRole");

const fu = require("../controllers/venueFollowUp");
const enq = require("../controllers/venueEnquiry");
const inter = require("../controllers/venueLeadInteraction");
const { getCrmOverview } = require("../controllers/venueCrmDashboard");
const { planFollowUpFor } = require("../scripts/migrate-followups-module");
const T = require("../utils/venueTime");

const TAG = `venue-fu-${Date.now()}`;
const OWNER = new mongoose.Types.ObjectId();
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const created = { venues: [], members: [], roles: [] };

const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const ownerReq = (venue, extra = {}) => ({ params: { slug: venue.slug, ...(extra.params || {}) }, query: extra.query || {}, body: extra.body || {}, venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: OWNER }, venueMember: null });
const memberReq = (venue, member, extra = {}) => ({ params: { slug: venue.slug, ...(extra.params || {}) }, query: extra.query || {}, body: extra.body || {}, venueOwner: { type: "venue_owner", venueId: venue._id, memberId: member._id, role: member.role }, venueMember: member });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };
const mirror = async (id) => VenueEnquiry.findById(id).select("followUpDate followUpNote").lean();

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const venue = await Venue.create({ name: `${TAG}-v`, slug: `${TAG}-v` });
    created.venues.push(venue._id);
    const mk = async (s, extra = {}) => { const m = await VenueTeamMember.create({ venueId: venue._id, ownerId: OWNER, name: `${TAG}-${s}`, phone: `${TAG}${s}`, role: "sales", isActive: true, ...extra }); created.members.push(m._id); return m; };
    const salesA = await mk("A");
    const salesB = await mk("B"); // owns nothing — the scoped attacker

    const lead = await VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} Sharma`, couplePhone: "9000100", stage: "contacted", assignedTo: salesA._id });
    const lead2 = await VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} Iyer`, couplePhone: "9000200", stage: "new", assignedTo: salesA._id });

    // ── create ──
    console.log("\n[create]");
    const tomorrow = T.addVenueDays(new Date(), 1);
    const c1 = await call(fu.createFollowUp, ownerReq(venue, { body: { leadId: String(lead._id), dueAt: tomorrow.toISOString(), type: "whatsapp", priority: "high", note: "Send the monsoon package" } }));
    ok(c1.code === 201, "create → 201");
    ok(c1.body.followUp.type === "whatsapp" && c1.body.followUp.priority === "high", "type + priority persist");
    ok(String(c1.body.followUp.assignedTo) === String(salesA._id), "defaults to the LEAD's owner, not the creator");
    let m = await mirror(lead._id);
    ok(m.followUpDate && new Date(m.followUpDate).getTime() === tomorrow.getTime(), "lead mirror picks up the new follow-up");
    ok(m.followUpNote === "Send the monsoon package", "note mirrors too — the rep never calls blind");

    const noLead = await call(fu.createFollowUp, ownerReq(venue, { body: { dueAt: tomorrow.toISOString() } }));
    ok(noLead.code === 400, "a follow-up without a lead is refused (it is not a task)");
    const badType = await call(fu.createFollowUp, ownerReq(venue, { body: { leadId: String(lead._id), dueAt: tomorrow.toISOString(), type: "carrier-pigeon" } }));
    ok(badType.code === 400, "unknown type → 400");
    const noDue = await call(fu.createFollowUp, ownerReq(venue, { body: { leadId: String(lead._id) } }));
    ok(noDue.code === 400, "missing dueAt → 400");

    // ── the mirror tracks the EARLIEST open row ──
    console.log("\n[mirror = next open follow-up]");
    const yesterday = T.addVenueDays(new Date(), -1);
    const c2 = await call(fu.createFollowUp, ownerReq(venue, { body: { leadId: String(lead._id), dueAt: yesterday.toISOString(), note: "Chase the advance" } }));
    ok(c2.code === 201, "a second open follow-up on the same lead is allowed");
    m = await mirror(lead._id);
    ok(new Date(m.followUpDate).getTime() === yesterday.getTime(), "mirror moves to the EARLIER of the two open rows");
    ok(m.followUpNote === "Chase the advance", "mirror note follows the same row");

    // ── list + buckets ──
    console.log("\n[list + buckets]");
    const list = await call(fu.listFollowUps, ownerReq(venue, { query: {} }));
    ok(list.code === 200 && list.body.followUps.length === 2, "list returns both open rows");
    ok(list.body.counts.overdue === 1 && list.body.counts.tomorrow === 1, "bucket counts split overdue vs tomorrow");
    ok(list.body.followUps.every((f) => f.lead && f.lead.name && f.lead.stage), "every row carries its lead (couple, stage) — no orphan rows in the UI");
    const overdueOnly = await call(fu.listFollowUps, ownerReq(venue, { query: { bucket: "overdue" } }));
    ok(overdueOnly.body.followUps.length === 1 && overdueOnly.body.followUps[0].bucket === "overdue", "bucket filter + server-computed bucket agree");
    const byType = await call(fu.listFollowUps, ownerReq(venue, { query: { type: "whatsapp" } }));
    ok(byType.body.followUps.length === 1, "type filter works");
    const byStage = await call(fu.listFollowUps, ownerReq(venue, { query: { stage: "new" } }));
    ok(byStage.body.followUps.length === 0, "pipeline-stage filter restricts to that stage's leads");
    const badBucket = await call(fu.listFollowUps, ownerReq(venue, { query: { bucket: "someday" } }));
    ok(badBucket.code === 400, "unknown bucket → 400");

    // ── the dashboard agrees with the list (invariant #7) ──
    const ov = await call(getCrmOverview, ownerReq(venue));
    ok(ov.body.myDay.overdue === list.body.counts.overdue, `dashboard overdue (${ov.body.myDay.overdue}) === list overdue (${list.body.counts.overdue})`);
    ok(ov.body.myDay.dueToday === list.body.counts.today, "dashboard dueToday === list today");

    // ── complete, with outcome + chained next ──
    console.log("\n[complete]");
    const openRow = await VenueFollowUp.findOne({ lead: lead._id, dueAt: yesterday });
    const nextDue = T.addVenueDays(new Date(), 4);
    const done = await call(fu.completeFollowUp, ownerReq(venue, {
      params: { followUpId: String(openRow._id) },
      body: { outcome: "Spoke to the father — wants a revised quote", next: { dueAt: nextDue.toISOString(), type: "call", note: "Walk through quote v2" } },
    }));
    ok(done.code === 200, "complete → 200");
    ok(done.body.followUp.status === "done" && done.body.followUp.completedAt, "row is done with a completion stamp");
    ok(String(done.body.followUp.completedBy) === String(OWNER), "completedBy records WHO closed it");
    ok(done.body.followUp.outcome.includes("revised quote"), "outcome is retained as history");
    ok(done.body.next && done.body.next._id, "the chained next follow-up was created in the same call");
    ok(done.body.leadHasNextStep === true, "response tells the UI the lead still has a next step");
    const stillThere = await VenueFollowUp.findById(openRow._id).lean();
    ok(stillThere && stillThere.status === "done", "completed row is RETAINED, never deleted");
    const dbl = await call(fu.completeFollowUp, ownerReq(venue, { params: { followUpId: String(openRow._id) }, body: { outcome: "again" } }));
    ok(dbl.code === 409, "double-click / re-complete → 409, no second timeline entry");

    const leadDoc = await VenueEnquiry.findById(lead._id).lean();
    ok(leadDoc.activities.some((a) => a.type === "followup_done"), "completion writes an activity entry on the lead");
    ok(leadDoc.activities.some((a) => a.type === "followup_scheduled"), "scheduling writes an activity entry on the lead");

    // ── cancel / reopen ──
    console.log("\n[cancel + reopen]");
    const toCancel = await VenueFollowUp.findOne({ lead: lead._id, status: "open", dueAt: tomorrow });
    const can = await call(fu.cancelFollowUp, ownerReq(venue, { params: { followUpId: String(toCancel._id) }, body: { reason: "Couple postponed" } }));
    ok(can.code === 200 && can.body.followUp.status === "cancelled", "cancel → 200, status cancelled");
    ok(can.body.followUp.cancelReason === "Couple postponed", "cancel reason retained");
    const cancelledRow = await VenueFollowUp.findById(toCancel._id).lean();
    ok(cancelledRow, "cancelled row is retained, not deleted");
    const listAfterCancel = await call(fu.listFollowUps, ownerReq(venue, { query: {} }));
    ok(!listAfterCancel.body.followUps.some((f) => String(f._id) === String(toCancel._id)), "a cancelled follow-up is no longer actionable in the default (open) list");
    const withClosed = await call(fu.listFollowUps, ownerReq(venue, { query: { status: "cancelled" } }));
    ok(withClosed.body.followUps.length === 1, "but it IS findable via the cancelled filter — history, not a black hole");

    const re = await call(fu.reopenFollowUp, ownerReq(venue, { params: { followUpId: String(toCancel._id) } }));
    ok(re.code === 200 && re.body.followUp.status === "open", "reopen → back in the queue");
    ok((await call(fu.reopenFollowUp, ownerReq(venue, { params: { followUpId: String(toCancel._id) } }))).code === 409, "reopening an open row → 409");

    // ── reschedule keeps history ──
    console.log("\n[reschedule]");
    const pushTo = T.addVenueDays(new Date(), 9);
    const resched = await call(fu.updateFollowUp, ownerReq(venue, { params: { followUpId: String(toCancel._id) }, body: { dueAt: pushTo.toISOString() } }));
    ok(resched.code === 200, "reschedule → 200");
    ok(resched.body.followUp.reschedules.length === 1, "the push is recorded as history, not a silent edit");
    ok(new Date(resched.body.followUp.reschedules[0].from).getTime() === tomorrow.getTime(), "history records where it moved FROM");

    // ── the legacy write paths still work, through the module ──
    console.log("\n[legacy paths route through the module]");
    const beforeRows = await VenueFollowUp.countDocuments({ lead: lead2._id });
    const ql = await call(inter.quickLog, ownerReq(venue, { params: { enquiryId: String(lead2._id) }, body: { type: "call", note: "rang", followUpDate: T.addVenueDays(new Date(), 2).toISOString(), followUpNote: "Send brochure" } }));
    ok(ql.code === 201, "quick-log with a follow-up → 201");
    ok((await VenueFollowUp.countDocuments({ lead: lead2._id })) === beforeRows + 1, "quick-log CREATED a real follow-up row");
    ok(ql.body.enquiry.followUpNote === "Send brochure", "quick-log response carries the refreshed mirror");
    const qlRow = await VenueFollowUp.findOne({ lead: lead2._id, status: "open" }).lean();
    ok(String(qlRow.assignedTo) === String(salesA._id), "the quick-logged follow-up lands on the lead's owner");

    const patched = await call(enq.updateEnquiry, ownerReq(venue, { params: { enquiryId: String(lead2._id) }, body: { followUpDate: T.addVenueDays(new Date(), 5).toISOString() } }));
    ok(patched.code === 200, "PATCH /enquiries with followUpDate → 200");
    ok((await VenueFollowUp.countDocuments({ lead: lead2._id })) === beforeRows + 1, "…edits the SAME open row rather than piling up duplicates");
    const rowAfterPatch = await VenueFollowUp.findOne({ lead: lead2._id, status: "open" }).lean();
    ok(rowAfterPatch.reschedules.length === 1, "…and records it as a reschedule");

    // Log & clear: the UI's "clear the touch" closes the row out as done.
    const cleared = await call(enq.updateEnquiry, ownerReq(venue, { params: { enquiryId: String(lead2._id) }, body: { followUpDate: null } }));
    ok(cleared.code === 200, "clearing the follow-up → 200");
    const m2 = await mirror(lead2._id);
    ok(!m2.followUpDate, "mirror cleared — the lead now shows as having no next step");
    ok((await VenueFollowUp.countDocuments({ lead: lead2._id, status: "done" })) === 1, "the cleared touch was closed as DONE, retained in history");

    // ── migration planner (pure) ──
    console.log("\n[migration planner]");
    ok(planFollowUpFor({ followUpDate: null }) === null, "no date → nothing to fold");
    const activePlan = planFollowUpFor({ _id: "a", venueId: "v", stage: "contacted", followUpDate: new Date("2026-09-01"), followUpNote: "n", assignedTo: "m" });
    ok(activePlan.status === "open" && activePlan.migratedFromLead === true, "an active lead's date becomes an OPEN row, flagged as migrated");
    ok(String(activePlan.assignedTo) === "m", "migrated row inherits the lead's assignee");
    const closedPlan = planFollowUpFor({ _id: "b", venueId: "v", stage: "booked", followUpDate: new Date("2026-09-01") });
    ok(closedPlan.status === "cancelled", "a booked lead's stale date folds as CANCELLED, not a resurrected next step");

    // ── DENY SWEEP: every new surface, as a scoped member owning nothing ──
    console.log("\n[deny-sweep: scoped Sales (owns nothing) vs another member's follow-ups]");
    const target = await VenueFollowUp.findOne({ lead: lead._id });
    const tp = { followUpId: String(target._id) };
    const snapshot = async () => JSON.stringify(await VenueFollowUp.findById(target._id).lean());
    const before = await snapshot();

    const dList = await call(fu.listFollowUps, memberReq(venue, salesB, { query: {} }));
    ok(dList.code === 200 && dList.body.followUps.length === 0, "listFollowUps → empty (no leakage of another member's follow-ups)");
    ok(dList.body.counts.overdue === 0 && dList.body.counts.open === 0, "…and the bucket COUNTS leak nothing either");

    const dGet = await call(fu.getFollowUp, memberReq(venue, salesB, { params: tp }));
    ok(dGet.code === 404, "getFollowUp → 404 (never 403 — existence not leaked)");

    const dPatch = await call(fu.updateFollowUp, memberReq(venue, salesB, { params: tp, body: { dueAt: new Date("2027-01-01").toISOString(), note: "hijacked" } }));
    ok(dPatch.code === 404, "updateFollowUp → 404");
    ok((await snapshot()) === before, "…and the write did NOT happen");

    const dDone = await call(fu.completeFollowUp, memberReq(venue, salesB, { params: tp, body: { outcome: "sneaky" } }));
    ok(dDone.code === 404, "completeFollowUp → 404");
    ok((await snapshot()) === before, "…and the write did NOT happen");

    const dCancel = await call(fu.cancelFollowUp, memberReq(venue, salesB, { params: tp, body: { reason: "sneaky" } }));
    ok(dCancel.code === 404, "cancelFollowUp → 404");
    ok((await snapshot()) === before, "…and the write did NOT happen");

    const dReopen = await call(fu.reopenFollowUp, memberReq(venue, salesB, { params: tp }));
    ok(dReopen.code === 404, "reopenFollowUp → 404");
    ok((await snapshot()) === before, "…and the write did NOT happen");

    const dDel = await call(fu.deleteFollowUp, memberReq(venue, salesB, { params: tp }));
    ok(dDel.code === 404, "deleteFollowUp → 404");
    ok(await VenueFollowUp.findById(target._id), "…and the row still exists");

    const dCreate = await call(fu.createFollowUp, memberReq(venue, salesB, { body: { leadId: String(lead._id), dueAt: tomorrow.toISOString() } }));
    ok(dCreate.code === 404, "createFollowUp against an unseen lead → 404");
    ok((await VenueFollowUp.countDocuments({ lead: lead._id, note: "" , createdBy: salesB._id })) === 0, "…and no row was created");

    // Retargeting a follow-up onto a lead you cannot see must also 404.
    const ownLead = await VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} Own`, stage: "new", assignedTo: salesB._id });
    const ownFu = await call(fu.createFollowUp, memberReq(venue, salesB, { body: { leadId: String(ownLead._id), dueAt: tomorrow.toISOString() } }));
    ok(ownFu.code === 201, "a scoped member CAN create a follow-up on their own lead");
    const steal = await call(fu.updateFollowUp, memberReq(venue, salesB, { params: { followUpId: String(ownFu.body.followUp._id) }, body: { leadId: String(lead._id) } }));
    ok(steal.code === 404, "retargeting a follow-up onto an unseen lead → 404");
    ok(String((await VenueFollowUp.findById(ownFu.body.followUp._id).lean()).lead) === String(ownLead._id), "…and the follow-up stayed on its own lead");

    // ── soft-deleted leads take their follow-ups with them (invariant #6) ──
    console.log("\n[soft-delete]");
    const openBefore = (await call(fu.listFollowUps, ownerReq(venue, { query: {} }))).body.followUps.length;
    await VenueEnquiry.updateOne({ _id: lead._id }, { $set: { deleted: true, deletedAt: new Date() } });
    const afterDel = await call(fu.listFollowUps, ownerReq(venue, { query: {} }));
    ok(afterDel.body.followUps.every((f) => String(f.lead._id) !== String(lead._id)), "a soft-deleted lead's follow-ups vanish from the list");
    ok(afterDel.body.followUps.length < openBefore, "…and the totals drop accordingly");
    ok((await call(fu.getFollowUp, ownerReq(venue, { params: tp }))).code === 404, "…and are unreachable by direct id, even for the owner");
    const ovAfterDel = await call(getCrmOverview, ownerReq(venue));
    ok(ovAfterDel.body.myDay.overdue === afterDel.body.counts.overdue, "dashboard still agrees with the list after a soft-delete");

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error("FATAL", err);
    fail++;
  } finally {
    for (const v of created.venues) {
      const leads = await VenueEnquiry.find({ venueId: v }).select("_id").lean();
      await VenueFollowUp.deleteMany({ lead: { $in: leads.map((l) => l._id) } });
      await VenueEnquiry.deleteMany({ venueId: v });
      await Venue.deleteOne({ _id: v });
    }
    await VenueTeamMember.deleteMany({ _id: { $in: created.members } });
    await VenueRole.deleteMany({ _id: { $in: created.roles } });
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
