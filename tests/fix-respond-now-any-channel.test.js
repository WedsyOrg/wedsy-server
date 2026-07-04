/**
 * Respond Now + buckets on the signal spine — Signal Matrix Slice 5.
 *
 * Read repoints (write paths landed in Slice 4, history backfilled):
 *   - respondNow exits on ANY-channel firstRespondedAt (call, WhatsApp press,
 *     timestamped note) — not just firstCalledAt.
 *   - the lead-hero banner reads the SAME field, so queue and banner agree.
 *   - lifecycle touched/fresh = lastActivityAt {$ne:null} / null — tasks now
 *     count as "touched" (but never as a response).
 *   - call-only metrics (GoldenWindowService.metrics avgFirstResponse etc.)
 *     stay keyed on firstCalledAt: a WA-responded lead is still "uncontacted".
 *
 *   node tests/fix-respond-now-any-channel.test.js
 *
 * Seeds isolated, uniquely-tagged docs against the local CRM DB; cleans up in
 * finally.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Department = require("../models/Department");
const LeadTask = require("../models/LeadTask");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const LeadChatMessage = require("../models/LeadChatMessage");
const AdminNotification = require("../models/AdminNotification");
const GoldenWindowService = require("../services/GoldenWindowService");
const CallCockpitService = require("../services/CallCockpitService");
const LeadTaskService = require("../services/LeadTaskService");
const { AddConversation } = require("../controllers/enquiry");
const { bucketOf, lifecycleFragment, temperatureCutoffs } = require("../utils/leadLifecycle");

const TAG = `rn-any-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const makeLead = (suffix, assignedTo) =>
  Enquiry.create({
    name: `RN Lead ${suffix}`, phone: `${TAG}-${suffix}`, verified: false,
    isInterested: false, isLost: false, stage: "new", source: "Default", assignedTo,
  });

// AddConversation is callback-style — resolve when the response lands.
const runHandler = (handler, req) =>
  new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      send(b) { resolve({ statusCode: this.statusCode, body: b }); },
      json(b) { resolve({ statusCode: this.statusCode, body: b }); },
    };
    handler(req, res);
  });

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

  const leadIds = [], adminIds = [];
  let dept = null;
  try {
    dept = await Department.create({ name: `${TAG}-dept` });
    const actor = await Admin.create({
      name: `${TAG}-actor`, email: `${TAG}@x.com`, phone: `${TAG}a`,
      password: "x", status: "active", departmentId: dept._id,
    });
    adminIds.push(actor._id);
    const { today } = temperatureCutoffs();
    const inRows = (rows, id) => rows.some((r) => String(r._id) === String(id));
    const respondRows = async () => (await GoldenWindowService.respondNow(actor._id)).rows;
    const matchesFragment = async (key, id) =>
      !!(await Enquiry.findOne({ $and: [{ _id: id }, lifecycleFragment(key, today)] }, { _id: 1 }).lean());

    const l1 = await makeLead("wa", actor._id);
    const l2 = await makeLead("task", actor._id);
    const l3 = await makeLead("note", actor._id);
    leadIds.push(l1._id, l2._id, l3._id);

    // ── 0. Fresh leads: all in Respond Now, all "fresh".
    console.log("0. fresh leads start in the queue and the fresh bucket");
    const rows0 = await respondRows();
    ok(inRows(rows0, l1._id) && inRows(rows0, l2._id) && inRows(rows0, l3._id), "all three fresh leads are in Respond Now");
    ok(bucketOf(await Enquiry.findById(l1._id).lean(), today) === "fresh", "bucketOf = fresh before any action");
    ok(await matchesFragment("fresh", l1._id), "Mongo fresh fragment matches too (mirror in lock-step)");

    // ── 1. WhatsApp press → leaves the queue, banner responded, bucket touched.
    console.log("1. WhatsApp press clears Respond Now + flips banner + bucket");
    await CallCockpitService.logWhatsappActivity(l1._id, { message: "hey!" }, actor._id);
    const rows1 = await respondRows();
    ok(!inRows(rows1, l1._id), "WA-responded lead is OUT of Respond Now");
    const clock1 = await GoldenWindowService.leadClock(l1._id);
    ok(clock1.responded === true && clock1.respondedAt != null, "banner responded=true from the same field");
    ok(clock1.bannerState === "responded", "bannerState = responded (no future follow-up)");
    const fresh1 = await Enquiry.findById(l1._id).lean();
    ok(bucketOf(fresh1, today) === "touched", "bucketOf = touched after the press");
    ok(await matchesFragment("touched", l1._id), "Mongo touched fragment matches (exact complement holds)");
    ok(fresh1.firstCalledAt == null, "firstCalledAt STILL null — call-only TAT untouched");

    // ── 2. Task → touched, but STAYS in Respond Now (internal ≠ response).
    console.log("2. a task makes the lead touched but does NOT clear the queue");
    await LeadTaskService.createTask(
      l2._id,
      { title: "Prep shortlist", assigneeId: actor._id, dueAt: new Date(Date.now() + 86400000).toISOString() },
      actor._id
    );
    const rows2 = await respondRows();
    ok(inRows(rows2, l2._id), "task-only lead is STILL in Respond Now (a response is still owed)");
    ok(bucketOf(await Enquiry.findById(l2._id).lean(), today) === "touched", "task-only lead is now 'touched'");
    ok(await matchesFragment("touched", l2._id), "Mongo touched fragment agrees for the task-only lead");

    // ── 3. Timestamped note (AddConversation) → response, leaves the queue.
    console.log("3. a timestamped conversation note clears Respond Now");
    const r3 = await runHandler(AddConversation, {
      params: { _id: String(l3._id) },
      body: { conversation: "Spoke on the phone they picked up on WhatsApp instead" },
    });
    ok(r3.statusCode === 200, "AddConversation succeeded");
    const rows3 = await respondRows();
    ok(!inRows(rows3, l3._id), "note-responded lead is OUT of Respond Now");
    const clock3 = await GoldenWindowService.leadClock(l3._id);
    ok(clock3.responded === true, "banner responded=true for the note too");

    // ── 4. Call-only metrics untouched: none of these leads were CALLED, so
    //      the golden-window metrics still see zero decided/contacted leads.
    console.log("4. metrics stay call-only (firstCalledAt)");
    const m = await GoldenWindowService.metrics(actor._id, "own", { periodDays: 7 });
    ok(m.total === 0, "no lead counts as decided — WA/note responses are not calls");
    ok(m.avgFirstResponseMinutes === null, "avgFirstResponseMinutes stays null (call-only)");
  } finally {
    if (leadIds.length) {
      await LeadTask.deleteMany({ leadId: { $in: leadIds } });
      await LeadInternalEvent.deleteMany({ leadId: { $in: leadIds } });
      await LeadChatMessage.deleteMany({ leadId: { $in: leadIds } });
      await AdminNotification.deleteMany({ leadId: { $in: leadIds } });
      await Enquiry.deleteMany({ _id: { $in: leadIds } });
    }
    if (adminIds.length) await Admin.deleteMany({ _id: { $in: adminIds } });
    if (dept) await Department.deleteMany({ _id: dept._id });
    await mongoose.disconnect();
  }

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("Test harness error:", e); process.exit(1); });
