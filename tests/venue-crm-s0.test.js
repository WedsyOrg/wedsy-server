// MB-CRM S0 backend foundations. Run: node tests/venue-crm-s0.test.js
// Sections: event-window validation, assignment contract (explicit wins /
// creator default / 422 non-member / auto round-robin / EDGE-2 dedup),
// leads_view_all scoping + DENY SWEEP (single-read by direct id), fine-grained
// capability gates, quick-log stage-advance, VenueTask CRUD + assign gate.
// Calls controllers directly with a mock req/res (DB-backed, tagged, cleaned up).
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueTeamMember = require("../models/VenueTeamMember");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueTask = require("../models/VenueTask");
const VenueLeadInteraction = require("../models/VenueLeadInteraction");
const VenueRole = require("../models/VenueRole");

const enq = require("../controllers/venueEnquiry");
const bulk = require("../controllers/venueBulk");
const inter = require("../controllers/venueLeadInteraction");
const tasks = require("../controllers/venueTask");
const team = require("../controllers/venueTeam");
const { validateAssignable, pickRoundRobinAssignee, resolveCreateAssignment } = require("../utils/venueLeadAssign");

const TAG = `mbcrm-s0-${Date.now()}`;
const OWNER_ID = new mongoose.Types.ObjectId();
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { venues: [], members: [], roles: [] };

const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const ownerReq = (venue, extra = {}) => ({
  params: { slug: venue.slug, ...(extra.params || {}) },
  query: extra.query || {},
  body: extra.body || {},
  venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: OWNER_ID },
  venueMember: null,
});
const memberReq = (venue, member, extra = {}) => ({
  params: { slug: venue.slug, ...(extra.params || {}) },
  query: extra.query || {},
  body: extra.body || {},
  venueOwner: { type: "venue_owner", venueId: venue._id, memberId: member._id, role: member.role },
  venueMember: member,
});
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    const venue = await Venue.create({ name: `${TAG}-v1`, slug: `${TAG}-v1` });
    const venueAuto = await Venue.create({ name: `${TAG}-v2`, slug: `${TAG}-v2`, settings: { autoAssignLeads: true } });
    const venueOther = await Venue.create({ name: `${TAG}-v3`, slug: `${TAG}-v3` });
    created.venues.push(venue._id, venueAuto._id, venueOther._id);

    const mk = async (v, s, extra = {}) => {
      const m = await VenueTeamMember.create({ venueId: v._id, ownerId: OWNER_ID, name: `${TAG}-${s}`, phone: `${TAG}${s}`, role: "sales", isActive: true, ...extra });
      created.members.push(m._id);
      return m;
    };
    const salesA = await mk(venue, "A");
    const salesB = await mk(venue, "B");
    const inactive = await mk(venue, "C", { isActive: false });
    const otherVenueMember = await mk(venueOther, "D");

    // ───────────────── SECTION 1: event-window validation ─────────────────
    console.log("\n[event-window]");
    {
      const base = new Date("2027-05-01T10:00:00Z");
      const plus24 = new Date(base.getTime() + 24 * 3600 * 1000);
      const plus8d = new Date(base.getTime() + 8 * 24 * 3600 * 1000);

      const good = await call(enq.createManualLead, ownerReq(venue, { body: { coupleName: `${TAG} good`, couplePhone: "9990001", checkIn: base, checkOut: plus24 } }));
      ok(good.code === 201, "valid 24h window creates (201)");
      ok(good.body.enquiry && Number(good.body.enquiry.eventDate) === base.getTime(), "eventDate is derived from checkIn");
      ok(good.body.enquiry.durationHours === 24, "durationHours computed = 24");

      const rev = await call(enq.createManualLead, ownerReq(venue, { body: { coupleName: `${TAG} rev`, couplePhone: "9990002", checkIn: plus24, checkOut: base } }));
      ok(rev.code === 400 && /after checkIn/.test(rev.body.message), "checkOut <= checkIn rejected (400)");

      const overCap = await call(enq.createManualLead, ownerReq(venue, { body: { coupleName: `${TAG} cap`, couplePhone: "9990003", checkIn: base, checkOut: plus8d } }));
      ok(overCap.code === 400 && /7 days/.test(overCap.body.message), "window > 7 days rejected (400)");

      // model-level invariant also fires on a raw save (any write path)
      let threw = false;
      try { await VenueEnquiry.create({ venueId: venue._id, coupleName: "x", checkIn: plus24, checkOut: base }); } catch (e) { threw = /after checkIn/.test(e.message); }
      ok(threw, "model pre-validate hook enforces the window on every write path");
    }

    // ───────────────── SECTION 2: assignment contract ─────────────────
    console.log("\n[assignment-contract]");
    {
      // validateAssignable
      ok((await validateAssignable(venue._id, salesA._id)).ok, "validateAssignable accepts an active member of the venue");
      ok(!(await validateAssignable(venue._id, inactive._id)).ok, "validateAssignable rejects an INACTIVE member");
      ok(!(await validateAssignable(venue._id, otherVenueMember._id)).ok, "validateAssignable rejects a member of ANOTHER venue");
      ok(!(await validateAssignable(venue._id, "not-an-id")).ok, "validateAssignable rejects a non-ObjectId");

      // explicit non-member on create → 422, creates NOTHING
      const before = await VenueEnquiry.countDocuments({ venueId: venue._id });
      const r422 = await call(enq.createManualLead, ownerReq(venue, { body: { coupleName: `${TAG} bad`, couplePhone: "9990010", assignedTo: inactive._id } }));
      const after = await VenueEnquiry.countDocuments({ venueId: venue._id });
      ok(r422.code === 422 && after === before, "explicit non-assignable target → 422 and no lead created");

      // member creating a lead defaults assignedTo to themselves + audit stamp
      const selfLead = await call(enq.createManualLead, memberReq(venue, salesA, { body: { coupleName: `${TAG} self`, couplePhone: "9990011" } }));
      ok(selfLead.code === 201 && String(selfLead.body.enquiry.assignedTo) === String(salesA._id), "manual create defaults to the creator (member)");
      const stamp = selfLead.body.enquiry.activities.find((a) => a.type === "manual_assigned");
      ok(stamp && stamp.via === "create_self" && String(stamp.actor) === String(salesA._id), "assignment is audited (via + actor)");

      // explicit override wins; stamped create_override
      const override = await call(enq.createManualLead, ownerReq(venue, { body: { coupleName: `${TAG} ov`, couplePhone: "9990012", assignedTo: salesB._id } }));
      const ovStamp = override.body.enquiry.activities.find((a) => a.via === "create_override");
      ok(override.code === 201 && String(override.body.enquiry.assignedTo) === String(salesB._id) && ovStamp, "explicit assignee wins and is stamped create_override");

      // a Sales member assigning to ANOTHER member without leads_reassign → 403
      const forbid = await call(enq.createManualLead, memberReq(venue, salesA, { body: { coupleName: `${TAG} f`, couplePhone: "9990013", assignedTo: salesB._id } }));
      ok(forbid.code === 403, "Sales cannot assign to another member on create (needs leads_reassign)");

      // auto round-robin when the venue opts in and nobody is specified
      const salesA2 = await mk(venueAuto, "AA");
      const salesB2 = await mk(venueAuto, "BB");
      const a1 = await call(enq.createManualLead, ownerReq(venueAuto, { body: { coupleName: `${TAG} rr1`, couplePhone: "9990020" } }));
      const a2 = await call(enq.createManualLead, ownerReq(venueAuto, { body: { coupleName: `${TAG} rr2`, couplePhone: "9990021" } }));
      const poolIds = [String(salesA2._id), String(salesB2._id)];
      const assigned = [String(a1.body.enquiry.assignedTo), String(a2.body.enquiry.assignedTo)];
      ok(a1.body.enquiry.assignedTo && a2.body.enquiry.assignedTo, "auto-assign fills an assignee when settings.autoAssignLeads is on");
      ok(assigned.every((id) => poolIds.includes(id)) && assigned[0] !== assigned[1], "round-robin load-balances across both members (distinct assignees)");
      const a1auto = a1.body.enquiry.activities.find((x) => x.via === "round_robin");
      ok(a1auto, "auto assignment stamped via round_robin");

      // EDGE 2: a dedup (import) into an existing lead IGNORES incoming assignedTo
      const existing = await VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} dup`, couplePhone: "9998887", assignedTo: salesA._id });
      const impRes = await enq.importLeadRows(venue._id, [{ coupleName: `${TAG} dup2`, couplePhone: "9998887", assignedTo: String(salesB._id) }]);
      const reread = await VenueEnquiry.findById(existing._id).lean();
      ok(impRes.skipped === 1 && String(reread.assignedTo) === String(salesA._id), "EDGE 2: dedup import does not reassign an already-owned lead");
    }

    // ───────────────── SECTION 3: leads_view_all scoping + DENY SWEEP ─────────────────
    console.log("\n[scoping + deny-sweep]");
    {
      const leadA = await VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} lA`, couplePhone: "8880001", assignedTo: salesA._id });
      const leadB = await VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} lB`, couplePhone: "8880002", assignedTo: salesB._id });

      const ownerList = await call(enq.getVenueEnquiries, ownerReq(venue));
      ok(ownerList.body.scoped === false && ownerList.body.total >= 2, "owner sees ALL leads (unscoped)");

      const bList = await call(enq.getVenueEnquiries, memberReq(venue, salesB));
      const bIds = bList.body.enquiries.map((e) => String(e._id));
      ok(bList.body.scoped === true && bIds.includes(String(leadB._id)) && !bIds.includes(String(leadA._id)), "Sales without leads_view_all sees ONLY own leads");

      // DENY SWEEP — direct-id read of ANOTHER member's lead
      const bReadsA = await call(enq.getEnquiryById, memberReq(venue, salesB, { params: { enquiryId: String(leadA._id) } }));
      ok(bReadsA.code === 404, "DENY SWEEP: Sales cannot read another member's lead by direct id (404)");
      const aReadsA = await call(enq.getEnquiryById, memberReq(venue, salesA, { params: { enquiryId: String(leadA._id) } }));
      ok(aReadsA.code === 200, "owner of the lead can read it by id");
      const ownerReadsA = await call(enq.getEnquiryById, ownerReq(venue, { params: { enquiryId: String(leadA._id) } }));
      ok(ownerReadsA.code === 200, "venue owner can read any lead by id");
    }

    // ───────────────── SECTION 4: fine-grained capability gates ─────────────────
    console.log("\n[fine-grained-caps]");
    {
      const lead = await VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} cap`, couplePhone: "7770001", assignedTo: salesA._id, estimatedValue: 100 });
      const p = { enquiryId: String(lead._id) };

      const stageOk = await call(enq.updateEnquiry, memberReq(venue, salesA, { params: p, body: { stage: "contacted" } }));
      ok(stageOk.code === 200, "Sales CAN change stage (has leads_change_stage)");

      const reassign = await call(enq.updateEnquiry, memberReq(venue, salesA, { params: p, body: { assignedTo: String(salesB._id) } }));
      ok(reassign.code === 403, "Sales CANNOT reassign (no leads_reassign)");

      const money = await call(enq.updateEnquiry, memberReq(venue, salesA, { params: p, body: { estimatedValue: 500 } }));
      ok(money.code === 403, "Sales CANNOT change deal value (no money_negotiate)");

      const ownerReassign = await call(enq.updateEnquiry, ownerReq(venue, { params: p, body: { assignedTo: String(salesB._id) } }));
      ok(ownerReassign.code === 200 && String(ownerReassign.body.enquiry.assignedTo) === String(salesB._id), "owner reassigns freely + audited");

      const badReassign = await call(enq.updateEnquiry, ownerReq(venue, { params: p, body: { assignedTo: String(inactive._id) } }));
      ok(badReassign.code === 422, "reassign to a non-assignable member → 422");

      // S3: profile fields are editable after creation
      const editProfile = await call(enq.updateEnquiry, ownerReq(venue, { params: p, body: { coupleName: `${TAG} Renamed`, couplePhone: "7770099", guestCount: 275, source: "referral", budget: "₹20L" } }));
      ok(editProfile.code === 200 && editProfile.body.enquiry.coupleName === `${TAG} Renamed` && editProfile.body.enquiry.guestCount === 275 && editProfile.body.enquiry.source === "referral", "profile fields (name/guests/source/budget) are editable post-create");
      ok(editProfile.body.enquiry.name === `${TAG} Renamed` && editProfile.body.enquiry.phone === "7770099" && editProfile.body.enquiry.couplePhone === "7770099", "name/phone mirrors stay in sync when coupleName/couplePhone edited");
      const badSource = await call(enq.updateEnquiry, ownerReq(venue, { params: p, body: { source: "not_a_source" } }));
      ok(badSource.code === 400, "an invalid source is rejected (400)");
    }

    // ───────────────── SECTION 5: quick-log stage-advance ─────────────────
    console.log("\n[quick-log]");
    {
      const lead = await VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} ql`, couplePhone: "6660001", stage: "new", assignedTo: salesA._id });
      const p = { enquiryId: String(lead._id) };
      const nextFu = new Date("2027-06-01T00:00:00Z");

      const callLog = await call(inter.quickLog, ownerReq(venue, { params: p, body: { type: "call", note: "rang", followUpDate: nextFu, followUpNote: "call back" } }));
      ok(callLog.code === 201 && callLog.body.advancedTo === "contacted", "quick-log call advances new → contacted");
      ok(Number(callLog.body.enquiry.followUpDate) === nextFu.getTime() && callLog.body.enquiry.followUpNote === "call back", "quick-log captures the next follow-up + note");

      const visit = await call(inter.quickLog, ownerReq(venue, { params: p, body: { type: "site_visit" } }));
      ok(visit.body.advancedTo === "site_visit_done", "quick-log site_visit advances → site_visit_done");

      const noteLog = await call(inter.quickLog, ownerReq(venue, { params: p, body: { type: "note", note: "fyi" } }));
      ok(noteLog.body.advancedTo === null, "quick-log note does NOT advance stage");

      // forward-only: a call on an already-advanced lead must not move it back
      const noBack = await call(inter.quickLog, ownerReq(venue, { params: p, body: { type: "call" } }));
      ok(noBack.body.advancedTo === null && noBack.body.enquiry.stage === "site_visit_done", "quick-log never moves the stage backward");

      const interactionCount = await VenueLeadInteraction.countDocuments({ enquiry: lead._id });
      ok(interactionCount >= 4, "each quick-log writes a VenueLeadInteraction");
    }

    // ───────────────── SECTION 6: VenueTask CRUD + assign gate ─────────────────
    console.log("\n[venue-tasks]");
    {
      const linkLead = await VenueEnquiry.create({ venueId: venue._id, coupleName: `${TAG} tl`, couplePhone: "5550001", assignedTo: salesA._id });

      const standalone = await call(tasks.createTask, ownerReq(venue, { body: { title: `${TAG} standalone` } }));
      ok(standalone.code === 201 && !standalone.body.task.linkedEnquiry, "create standalone task");

      const linked = await call(tasks.createTask, ownerReq(venue, { body: { title: `${TAG} linked`, linkedEnquiry: String(linkLead._id), assignedTo: String(salesA._id) } }));
      ok(linked.code === 201 && String(linked.body.task.linkedEnquiry) === String(linkLead._id), "create lead-linked task");

      const badLink = await call(tasks.createTask, ownerReq(venue, { body: { title: `${TAG} badlink`, linkedEnquiry: String(new mongoose.Types.ObjectId()) } }));
      ok(badLink.code === 404, "linking a non-existent lead → 404");

      // Sales does NOT hold tasks_assign_others → cannot assign a task to others.
      const salesAssignOther = await call(tasks.createTask, memberReq(venue, salesA, { body: { title: `${TAG} sa`, assignedTo: String(salesB._id) } }));
      ok(salesAssignOther.code === 403, "Sales cannot assign a task to others (no tasks_assign_others)");

      // A member WHOSE bundle includes tasks_assign_others CAN (gate opens).
      const grantRole = await VenueRole.create({ venue: venue._id, name: `${TAG}-taskrole`, capabilities: ["leads", "tasks_assign_others"] });
      created.roles.push(grantRole._id);
      const grantMember = await VenueTeamMember.create({ venueId: venue._id, ownerId: OWNER_ID, name: `${TAG}-G`, phone: `${TAG}G`, role: "sales", roleRef: grantRole._id, isActive: true });
      created.members.push(grantMember._id);
      const allowedAssign = await call(tasks.createTask, memberReq(venue, grantMember, { body: { title: `${TAG} ga`, assignedTo: String(salesB._id) } }));
      ok(allowedAssign.code === 201 && String(allowedAssign.body.task.assignedTo) === String(salesB._id), "a bundle with tasks_assign_others CAN assign to others (gate opens)");

      // Sales assigning to SELF is fine, and defaults to self
      const salesSelf = await call(tasks.createTask, memberReq(venue, salesA, { body: { title: `${TAG} ss` } }));
      ok(salesSelf.code === 201 && String(salesSelf.body.task.assignedTo) === String(salesA._id), "member task defaults to the creator");

      const tid = { taskId: String(linked.body.task._id) };
      const done = await call(tasks.completeTask, ownerReq(venue, { params: tid }));
      ok(done.code === 200 && done.body.task.status === "done" && done.body.task.completedAt, "complete a task");
      const reopened = await call(tasks.reopenTask, ownerReq(venue, { params: tid }));
      ok(reopened.code === 200 && reopened.body.task.status === "open" && !reopened.body.task.completedAt, "reopen a task");

      // list scoping: Sales sees only own; filter=all falls back to mine without team_see_pipelines
      const salesList = await call(tasks.listTasks, memberReq(venue, salesA, { query: { filter: "all" } }));
      const salesTaskIds = salesList.body.tasks.map((t) => String(t._id));
      ok(salesList.body.scoped === true && !salesTaskIds.includes(String(standalone.body.task._id)), "Sales task list is scoped (can't see owner-only tasks even with filter=all)");
      ok(salesTaskIds.includes(String(salesSelf.body.task._id)), "Sales sees their OWN task");

      const del = await call(tasks.deleteTask, ownerReq(venue, { params: tid }));
      ok(del.code === 200 && (await VenueTask.countDocuments({ _id: linked.body.task._id })) === 0, "delete a task");
    }

    // ───────────────── SECTION 7: round-robin load balance ─────────────────
    console.log("\n[round-robin]");
    {
      const v = await Venue.create({ name: `${TAG}-rr`, slug: `${TAG}-rr` });
      created.venues.push(v._id);
      const m1 = await mk(v, "RR1");
      const m2 = await mk(v, "RR2");
      // m1 currently holds 1 open lead, m2 holds 0 → next pick must be m2
      await VenueEnquiry.create({ venueId: v._id, coupleName: "x", couplePhone: "111", assignedTo: m1._id, stage: "new" });
      const pick = await pickRoundRobinAssignee(v._id);
      ok(String(pick) === String(m2._id), "round-robin picks the least-loaded member");
      // terminal leads don't count toward load
      await VenueEnquiry.create({ venueId: v._id, coupleName: "y", couplePhone: "222", assignedTo: m2._id, stage: "booked" });
      const pick2 = await pickRoundRobinAssignee(v._id);
      ok(String(pick2) === String(m2._id), "booked/lost leads are not counted as active load");
    }

    // ───────────────── SECTION 8: assignable-members roster (S3 support) ─────────────────
    console.log("\n[assignable-roster]");
    {
      const res = await call(team.listAssignableMembers, ownerReq(venue));
      const ids = (res.body.members || []).map((m) => String(m._id));
      ok(res.code === 200 && ids.includes(String(salesA._id)) && ids.includes(String(salesB._id)), "assignable roster lists active members of the venue");
      ok(!ids.includes(String(inactive._id)), "assignable roster excludes INACTIVE members");
      ok(!ids.includes(String(otherVenueMember._id)), "assignable roster excludes members of other venues");
      ok((res.body.members || []).every((m) => m.name !== undefined && m.role !== undefined), "roster returns id + name (+ role) only");
    }
  } catch (err) {
    console.error("FATAL", err);
    fail++;
  } finally {
    // cleanup
    try {
      const vids = created.venues;
      await VenueEnquiry.deleteMany({ venueId: { $in: vids } });
      await VenueTask.deleteMany({ venue: { $in: vids } });
      await VenueLeadInteraction.deleteMany({ venue: { $in: vids } });
      await VenueTeamMember.deleteMany({ _id: { $in: created.members } });
      await VenueRole.deleteMany({ venue: { $in: vids } });
      await Venue.deleteMany({ _id: { $in: vids } });
    } catch (e) { console.error("cleanup error", e.message); }
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
