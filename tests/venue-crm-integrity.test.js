// Cross-module integrity defects found in the CRM audit. Run:
//   node tests/venue-crm-integrity.test.js
//
//   A. Interaction attribution — every touch was stamped with the OWNER's id
//      even when a member logged it, so "who called this couple?" answered with
//      the owner's name on every row.
//   B. Task lifecycle → lead timeline — completing/reopening/deleting a
//      lead-linked task wrote nothing to the lead's history.
//   C. Invariant #12 — deleting a lead released nothing silently: a live hold
//      kept calendar inventory blocked and linked work was orphaned, with no
//      signal to anyone.
//   D. Invariant #1 — the PUBLIC create never seeded contacts[], so every
//      inbound web lead existed without the >=1 contact the invariant requires.
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueTask = require("../models/VenueTask");
const VenueHold = require("../models/VenueHold");
const VenueBooking = require("../models/VenueBooking");
const VenueFollowUp = require("../models/VenueFollowUp");
const VenueTeamMember = require("../models/VenueTeamMember");
const VenueOwner = require("../models/VenueOwner");
const VenueLeadInteraction = require("../models/VenueLeadInteraction");

const enq = require("../controllers/venueEnquiry");
const inter = require("../controllers/venueLeadInteraction");
const tasks = require("../controllers/venueTask");

const TAG = `venue-int-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const created = { venues: [], members: [], owners: [] };

const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };

(async () => {
  let OWNER;
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const venue = await Venue.create({ name: `${TAG}-v`, slug: `${TAG}-v` });
    created.venues.push(venue._id);
    const ownerDoc = await VenueOwner.create({ venueId: venue._id, name: "Rajesh the Owner", phone: `${TAG}own`, isActive: true });
    created.owners.push(ownerDoc._id);
    OWNER = ownerDoc._id;
    const member = await VenueTeamMember.create({ venueId: venue._id, ownerId: OWNER, name: "Priya the Rep", phone: `${TAG}m`, role: "sales", isActive: true });
    created.members.push(member._id);

    const ownerReq = (extra = {}) => ({ params: { slug: venue.slug, ...(extra.params || {}) }, query: extra.query || {}, body: extra.body || {}, venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: OWNER }, venueMember: null });
    const memberReq = (extra = {}) => ({ params: { slug: venue.slug, ...(extra.params || {}) }, query: extra.query || {}, body: extra.body || {}, venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: OWNER, memberId: member._id, role: "sales" }, venueMember: member });

    const lead = await VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} Sharma`, couplePhone: "9000901", stage: "contacted", assignedTo: member._id });

    // ── A. attribution ──
    console.log("\n[A. interaction attribution: who actually did this?]");
    await call(inter.addInteraction, memberReq({ params: { enquiryId: String(lead._id) }, body: { type: "call", note: "Priya rang them" } }));
    await call(inter.addInteraction, ownerReq({ params: { enquiryId: String(lead._id) }, body: { type: "whatsapp", note: "Owner followed up" } }));

    const rows = await VenueLeadInteraction.find({ enquiry: lead._id }).sort({ createdAt: 1 }).lean();
    const byMember = rows.find((r) => r.note === "Priya rang them");
    const byOwner = rows.find((r) => r.note === "Owner followed up");
    ok(String(byMember.createdBy) === String(member._id), "THE FIX: a member's call is stamped with the MEMBER (was: always the owner)");
    ok(byMember.createdByType === "member", "…and typed as a member so the name can be resolved");
    ok(String(byOwner.createdBy) === String(OWNER) && byOwner.createdByType === "owner", "the owner's own touch is still stamped to the owner");

    const timeline = await call(inter.getInteractions, ownerReq({ params: { enquiryId: String(lead._id) } }));
    const tMember = timeline.body.interactions.find((r) => r.note === "Priya rang them");
    const tOwner = timeline.body.interactions.find((r) => r.note === "Owner followed up");
    ok(tMember.createdBy && tMember.createdBy.name === "Priya the Rep", "the timeline resolves the MEMBER's name (populate could not — createdBy is polymorphic)");
    ok(tOwner.createdBy && tOwner.createdBy.name === "Rajesh the Owner", "…and the owner's name from the other collection");

    // The same question asked of the lead's OWN timeline. Activity rows stamp
    // `actor` correctly, but the detail read handed back a bare id, so the
    // workbench had no name to render and labelled every entry "System" —
    // including the ones a person had just performed. Its own lead, so the
    // task/hold counts the later sections assert on stay untouched.
    const attrLead = await VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} Attrib`, couplePhone: "9000902", stage: "contacted", assignedTo: member._id });
    await call(tasks.createTask, memberReq({ body: { title: "Member's task", linkedEnquiry: String(attrLead._id) } }));
    await call(tasks.createTask, ownerReq({ body: { title: "Owner's task", linkedEnquiry: String(attrLead._id) } }));
    await VenueEnquiry.updateOne(
      { _id: attrLead._id },
      { $push: { activities: { type: "imported", description: "Imported from sheet", timestamp: new Date() } } },
    );

    const detail = await call(enq.getEnquiryById, ownerReq({ params: { enquiryId: String(attrLead._id) } }));
    const acts = detail.body.enquiry.activities;
    const byMemberAct = acts.find((a) => a.description === "Task added: Member's task");
    const byOwnerAct = acts.find((a) => a.description === "Task added: Owner's task");
    const unattributed = acts.find((a) => a.type === "imported");
    ok(byMemberAct && byMemberAct.actorName === "Priya the Rep",
      "THE FIX: the lead timeline names the MEMBER who acted (was: a bare id the UI rendered as \"System\")");
    ok(byOwnerAct && byOwnerAct.actorName === "Rajesh the Owner", "…and the owner's own action carries the owner's name");
    ok(unattributed && unattributed.actorName === null,
      "a genuinely actor-less entry stays unnamed, so \"System\" keeps meaning system");

    // ── B. task lifecycle on the lead timeline ──
    console.log("\n[B. a lead-linked task's lifecycle is lead history]");
    const t1 = await call(tasks.createTask, ownerReq({ body: { title: "Send the brochure", linkedEnquiry: String(lead._id) } }));
    ok(t1.code === 201, "task created");
    const taskId = String(t1.body.task._id);
    let fresh = await VenueEnquiry.findById(lead._id).lean();
    ok(fresh.activities.some((a) => a.type === "task_created"), "creating a lead-linked task lands on the lead's timeline");

    await call(tasks.completeTask, ownerReq({ params: { taskId } }));
    fresh = await VenueEnquiry.findById(lead._id).lean();
    ok(fresh.activities.some((a) => a.type === "task_completed" && a.description.includes("Send the brochure")),
      "THE FIX: completing it is recorded on the lead (was: invisible in lead history)");

    const dbl = await call(tasks.completeTask, ownerReq({ params: { taskId } }));
    ok(dbl.body.alreadyDone === true, "re-completing is a no-op…");
    fresh = await VenueEnquiry.findById(lead._id).lean();
    ok(fresh.activities.filter((a) => a.type === "task_completed").length === 1, "…and does NOT write a duplicate timeline entry");

    await call(tasks.reopenTask, ownerReq({ params: { taskId } }));
    fresh = await VenueEnquiry.findById(lead._id).lean();
    ok(fresh.activities.some((a) => a.type === "task_reopened"), "reopening is recorded too");

    const standalone = await call(tasks.createTask, ownerReq({ body: { title: "Order flowers" } }));
    ok(standalone.code === 201, "a standalone task still works…");
    const before = (await VenueEnquiry.findById(lead._id).lean()).activities.length;
    await call(tasks.completeTask, ownerReq({ params: { taskId: String(standalone.body.task._id) } }));
    ok((await VenueEnquiry.findById(lead._id).lean()).activities.length === before, "…and writes to no lead's timeline (it has no lead)");

    // ── C. invariant #12 ──
    console.log("\n[C. invariant #12: deleting a lead releases nothing silently]");
    const hold = await VenueHold.create({
      venue: venue._id, dates: [new Date("2027-05-05T00:00:00Z")], requestedBy: "owner",
      requestedByName: "Sharma", linkedEnquiry: lead._id, status: "approved",
      expiresAt: new Date(Date.now() + 7 * 86400000),
    });
    await VenueFollowUp.create({ venue: venue._id, lead: lead._id, dueAt: new Date(Date.now() + 86400000), status: "open" });

    const del = await call(enq.deleteEnquiry, ownerReq({ params: { enquiryId: String(lead._id) } }));
    ok(del.code === 200 && del.body.success, "delete → 200");
    ok(del.body.releasedNothing, "the response reports what the lead was still holding");
    ok(del.body.releasedNothing.holds.length === 1 && String(del.body.releasedNothing.holds[0]._id) === String(hold._id),
      "THE FIX: the live hold is surfaced for explicit release (was: silently kept blocking the date)");
    ok(del.body.releasedNothing.openTasks === 1, "orphaned open tasks are surfaced for review");
    ok(del.body.releasedNothing.openFollowUps === 1, "orphaned open follow-ups are surfaced too");
    ok((await VenueHold.findById(hold._id).lean()).status === "approved",
      "the hold is NOT auto-released — silently freeing a contested date would be its own bug");

    // A booked lead cannot be deleted out from under its booking.
    const bookedLead = await VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} Booked`, couplePhone: "9000902", stage: "booked" });
    const bk = await VenueBooking.create({ venue: venue._id, enquiry: bookedLead._id, coupleName: "Booked", status: "confirmed" });
    const delBooked = await call(enq.deleteEnquiry, ownerReq({ params: { enquiryId: String(bookedLead._id) } }));
    ok(delBooked.code === 409, "a lead with a confirmed booking refuses deletion (409)");
    ok(String(delBooked.body.bookingId) === String(bk._id), "…and points at the booking to cancel first");
    ok((await VenueEnquiry.findById(bookedLead._id).lean()).deleted !== true, "…and the lead was NOT deleted");

    // ── D. invariant #1 ──
    console.log("\n[D. invariant #1: a lead always has at least one contact]");
    const pub = await call(enq.createEnquiry, { params: { slug: venue.slug }, query: {}, body: { coupleName: "Web Couple", couplePhone: "9876500903", email: "w@x.com" }, auth: null });
    ok(pub.code === 201, "public enquiry → 201");
    const webLead = await VenueEnquiry.findById(pub.body.enquiry._id).lean();
    ok(webLead.contacts.length === 1, "THE FIX: an inbound web lead is born with a contact (was: contacts[] empty)");
    ok(webLead.contacts[0].isPrimary === true, "…marked primary");
    ok(webLead.contacts[0].name === "Web Couple" && webLead.contacts[0].phone === "9876500903", "…carrying the couple's own name and phone");

    // The dedup surface keys on contact phones, so this also makes inbound
    // leads visible to the "enquired before" banner.
    const dupCheck = await call(enq.checkEnquiryExists, { params: { slug: venue.slug }, query: { phone: "9876500903" }, body: {}, venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: OWNER }, venueMember: null });
    ok(dupCheck.body.exists === true, "…so dedup now matches an inbound lead on its contact phone");

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error("FATAL", err);
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
      await Venue.deleteOne({ _id: v });
    }
    await VenueTeamMember.deleteMany({ _id: { $in: created.members } });
    await VenueOwner.deleteMany({ _id: { $in: created.owners } });
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
