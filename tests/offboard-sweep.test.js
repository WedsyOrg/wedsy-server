/**
 * Slice A3 — OFFBOARDING SWEEP (rides the disabled-user fix).
 *
 *   node tests/offboard-sweep.test.js
 *
 * Covers: disable response { active, snoozed, total }; reassign moves
 * leads + lanes + tasks with notes/events and PRESERVES snooze; triage nulls
 * assignment into the triage queue; disabled target → 422; source must be
 * disabled (409); enabled admins' books untouched.
 *
 * Seeds uniquely-tagged docs against the local CRM DB; cleans up in finally.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const ActivityLog = require("../models/ActivityLog");
const LeadLane = require("../models/LeadLane");
const LaneEntry = require("../models/LaneEntry");
const LeadTask = require("../models/LeadTask");
const LeadInternalEvent = require("../models/LeadInternalEvent");

const OffboardService = require("../services/OffboardService");
const adminController = require("../controllers/admin");

const TAG = `offboard-${Date.now()}`;
const DAY_MS = 24 * 3600 * 1000;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const throwsStatus = async (fn, status) => {
  try { await fn(); return false; } catch (e) { return e && e.status === status; }
};
const mockRes = () => ({
  statusCode: 0, body: null,
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; return this; },
  send(b) { this.body = b; return this; },
});

const makeLead = (suffix, extra = {}) =>
  Enquiry.create({
    name: `${TAG}-${suffix}`, phone: `${TAG}-${suffix}`, verified: false, isInterested: false,
    isLost: false, stage: "new", source: "Default", lostStatus: "none", ...extra,
  });

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

  const created = { admins: [], leads: [] };
  try {
    const founder = await Admin.create({
      name: `${TAG}-founder`, email: `${TAG}-f@x.com`, phone: `${TAG}f`, password: "x",
      roles: ["owner"], status: "active",
    });
    const leaving = await Admin.create({
      name: `${TAG}-leaving`, email: `${TAG}-l@x.com`, phone: `${TAG}l`, password: "x",
      roles: ["sales"], status: "active", isDisabled: false,
    });
    const receiver = await Admin.create({
      name: `${TAG}-receiver`, email: `${TAG}-r@x.com`, phone: `${TAG}r`, password: "x",
      roles: ["sales"], status: "active",
    });
    const otherDisabled = await Admin.create({
      name: `${TAG}-otherdis`, email: `${TAG}-od@x.com`, phone: `${TAG}od`, password: "x",
      roles: ["sales"], status: "active", isDisabled: true,
    });
    const bystander = await Admin.create({
      name: `${TAG}-bystander`, email: `${TAG}-b@x.com`, phone: `${TAG}b`, password: "x",
      roles: ["sales"], status: "active",
    });
    created.admins.push(founder._id, leaving._id, receiver._id, otherDisabled._id, bystander._id);

    // Leaving admin's book: 2 active + 1 snoozed + 1 won (must not move).
    const active1 = await makeLead("a1", { assignedTo: leaving._id });
    const active2 = await makeLead("a2", { assignedTo: leaving._id, stage: "contacted" });
    const parked = await makeLead("parked", { assignedTo: leaving._id, firstRespondedAt: new Date() });
    const wonLead = await makeLead("won", { assignedTo: leaving._id, stage: "won" });
    const bystanderLead = await makeLead("bystander", { assignedTo: bystander._id });
    created.leads.push(active1._id, active2._id, parked._id, wonLead._id, bystanderLead._id);
    const wakeDate = new Date(Date.now() + 45 * DAY_MS);
    await Enquiry.collection.updateOne(
      { _id: parked._id },
      { $set: { snoozedUntil: wakeDate, snoozeSource: new mongoose.Types.ObjectId() } }
    );

    // Lanes: one live owned by leaving, one DONE owned by leaving (history —
    // stays), one live owned by the bystander.
    const liveLane = await LeadLane.create({
      leadId: active1._id, key: "decor", name: "Décor", state: "active",
      ownerId: leaving._id, lastUpdateAt: new Date(),
    });
    const doneLane = await LeadLane.create({
      leadId: active2._id, key: "venue", name: "Venue", state: "done",
      ownerId: leaving._id, lastUpdateAt: new Date(),
    });
    const bystanderLane = await LeadLane.create({
      leadId: bystanderLead._id, key: "makeup", name: "Makeup", state: "active",
      ownerId: bystander._id, lastUpdateAt: new Date(),
    });

    // Tasks: one open + one done for leaving; one open for the bystander.
    const openTask = await LeadTask.create({
      leadId: active1._id, title: "call venue", assigneeId: leaving._id, assignerId: founder._id, status: "open",
    });
    const doneTask = await LeadTask.create({
      leadId: active1._id, title: "old", assigneeId: leaving._id, assignerId: founder._id, status: "done",
    });
    const bystanderTask = await LeadTask.create({
      leadId: bystanderLead._id, title: "other", assigneeId: bystander._id, assignerId: founder._id, status: "open",
    });

    // ── 1. Disable response: { active, snoozed, total } ─────────────────────
    const res1 = mockRes();
    await adminController.SetMemberAccess(
      { body: { targetAdminId: String(leaving._id), disabled: true }, auth: { user_id: String(founder._id) } },
      res1
    );
    ok(res1.statusCode === 200, `disable succeeds (got ${res1.statusCode})`);
    const body1 = res1.body || {};
    ok(body1.total === 3 && body1.snoozed === 1 && body1.active === 2,
      `disable returns TOP-LEVEL { active:2, snoozed:1, total:3 } (got ${JSON.stringify({ active: body1.active, snoozed: body1.snoozed, total: body1.total })})`);

    // ── 2. Guards ─────────────────────────────────────────────────────────────
    ok(await throwsStatus(() => OffboardService.offboardLeads(String(receiver._id), { mode: "reassign", targetAdminId: String(founder._id) }), 409),
      "offboarding a NOT-disabled admin → 409 (disable them first)");
    ok(await throwsStatus(() => OffboardService.offboardLeads(String(leaving._id), { mode: "reassign", targetAdminId: String(otherDisabled._id) }), 422),
      "reassign to a DISABLED target → 422");
    ok(await throwsStatus(() => OffboardService.offboardLeads(String(leaving._id), { mode: "bogus" }), 400),
      "invalid mode → 400");
    ok(await throwsStatus(() => OffboardService.offboardLeads(String(leaving._id), { mode: "reassign" }), 400),
      "reassign without targetAdminId → 400");

    // ── 3. Reassign moves leads + lanes + tasks, preserves snooze ────────────
    const result = await OffboardService.offboardLeads(
      String(leaving._id), { mode: "reassign", targetAdminId: String(receiver._id) }, founder._id
    );
    ok(result.moved === 3 && result.lanes === 1 && result.tasks === 1,
      `response counts { moved:3, lanes:1, tasks:1 } (got ${JSON.stringify({ moved: result.moved, lanes: result.lanes, tasks: result.tasks })})`);

    const movedParked = await Enquiry.findById(parked._id).lean();
    ok(String(movedParked.assignedTo) === String(receiver._id), "snoozed lead reassigned to the receiver");
    ok(movedParked.snoozedUntil && +new Date(movedParked.snoozedUntil) === +wakeDate,
      "snoozedUntil PRESERVED through the reassign (receiver inherits the wake date)");
    ok((movedParked.updates?.notes || "").includes(`Reassigned from ${TAG}-leaving on offboarding`) &&
       (movedParked.updates?.notes || "").includes("callback"),
      "system note appended, mentioning the promised callback date");
    const movedActive = await Enquiry.findById(active1._id).lean();
    ok(String(movedActive.assignedTo) === String(receiver._id) &&
       !(movedActive.updates?.notes || "").includes("callback"),
      "active lead reassigned; its note has no callback clause");
    ok(String((await Enquiry.findById(wonLead._id).lean()).assignedTo) === String(leaving._id),
      "won lead NOT moved (open = not won/lost)");
    ok(await LeadInternalEvent.exists({ leadId: parked._id, type: "lead_offboarded", "payload.mode": "reassign" }),
      "journey event lead_offboarded recorded");

    ok(String((await LeadLane.findById(liveLane._id).lean()).ownerId) === String(receiver._id),
      "live lane ownership moved to the receiver");
    ok(String((await LeadLane.findById(doneLane._id).lean()).ownerId) === String(leaving._id),
      "done lane untouched (history preserved)");
    ok(await LaneEntry.exists({ laneId: liveLane._id, autoType: "owner_changed" }),
      "lane got an owner_changed auto entry");
    ok(String((await LeadTask.findById(openTask._id).lean()).assigneeId) === String(receiver._id),
      "open task reassigned");
    ok(String((await LeadTask.findById(doneTask._id).lean()).assigneeId) === String(leaving._id),
      "done task untouched");

    // Bystander (enabled admin) fully untouched.
    ok(String((await Enquiry.findById(bystanderLead._id).lean()).assignedTo) === String(bystander._id) &&
       String((await LeadLane.findById(bystanderLane._id).lean()).ownerId) === String(bystander._id) &&
       String((await LeadTask.findById(bystanderTask._id).lean()).assigneeId) === String(bystander._id),
      "enabled admin's leads/lanes/tasks untouched");

    // ── 4. Triage mode nulls assignment into the triage queue ────────────────
    // Move the book to otherDisabled (already disabled) by seeding directly.
    const t1 = await makeLead("t1", { assignedTo: otherDisabled._id });
    const t2 = await makeLead("t2", { assignedTo: otherDisabled._id, firstRespondedAt: new Date() });
    created.leads.push(t1._id, t2._id);
    await Enquiry.collection.updateOne({ _id: t2._id }, { $set: { snoozedUntil: wakeDate } });
    await LeadLane.create({
      leadId: t1._id, key: "vendors", name: "Vendors", state: "queued",
      ownerId: otherDisabled._id, lastUpdateAt: new Date(), wake: { type: "manual" },
    });
    await LeadTask.create({
      leadId: t1._id, title: "triage task", assigneeId: otherDisabled._id, assignerId: founder._id, status: "open",
    });

    const triaged = await OffboardService.offboardLeads(String(otherDisabled._id), { mode: "triage" }, founder._id);
    ok(triaged.moved === 2 && triaged.lanes === 1 && triaged.tasks === 1,
      `triage counts { moved:2, lanes:1, tasks:1 } (got ${JSON.stringify({ moved: triaged.moved, lanes: triaged.lanes, tasks: triaged.tasks })})`);
    const tr1 = await Enquiry.findById(t1._id).lean();
    ok(tr1.assignedTo === null && tr1.triagePending === true && !!tr1.triageEnteredAt,
      "triage mode: assignedTo null + triagePending set (enters the triage queue)");
    const tr2 = await Enquiry.findById(t2._id).lean();
    ok(tr2.assignedTo === null && +new Date(tr2.snoozedUntil) === +wakeDate,
      "triage mode preserves snoozedUntil too");
    ok((await LeadLane.findOne({ leadId: t1._id, key: "vendors" }).lean()).ownerId === null,
      "triage mode nulls lane ownership");
    ok((await LeadTask.findOne({ leadId: t1._id, title: "triage task" }).lean()).assigneeId === null,
      "triage mode nulls open task assignee");

    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    const leadIds = created.leads;
    await LaneEntry.deleteMany({ leadId: { $in: leadIds } }).catch(() => {});
    await LeadLane.deleteMany({ leadId: { $in: leadIds } }).catch(() => {});
    await LeadTask.deleteMany({ leadId: { $in: leadIds } }).catch(() => {});
    await LeadInternalEvent.deleteMany({ leadId: { $in: leadIds } }).catch(() => {});
    await ActivityLog.deleteMany({ "meta.targetAdminId": { $in: created.admins.map(String) } }).catch(() => {});
    await ActivityLog.deleteMany({ entityId: { $in: created.admins.map(String) } }).catch(() => {});
    await Enquiry.deleteMany({ _id: { $in: leadIds } }).catch(() => {});
    await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
