/**
 * Follow-up store bridging — Signal Matrix Slice 6.
 *
 * TWO follow-up stores exist by design and are NOT merged:
 *   cadence — embedded Enquiry.followUps[] (pre-qual next steps, zero-orphan
 *             gate), completed via PUT /enquiry/:id/follow-up/:fid/complete
 *   journey — the Followup collection (post-qual client touches), completed
 *             via PATCH /enquiry/:id/followups/:fid
 *
 * This slice bridges the READS: GET /enquiry/:id/followups returns both stores
 * tagged store+completeVia, and the dashboard's Today's Mission surfaces both.
 *
 *   node tests/fix-followup-bridge.test.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Department = require("../models/Department");
const Followup = require("../models/Followup");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const LeadChatMessage = require("../models/LeadChatMessage");
const AdminNotification = require("../models/AdminNotification");
const CalendarEvent = require("../models/CalendarEvent");
const FollowupService = require("../services/FollowupService");
const CallCockpitService = require("../services/CallCockpitService");
const DashboardService = require("../services/DashboardService");
const LeadLifecycleService = require("../services/LeadLifecycleService");

const TAG = `fu-bridge-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

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

    const lead = await Enquiry.create({
      name: "Bridge Lead", phone: `${TAG}`, verified: false, isInterested: false,
      isLost: false, stage: "contacted", source: "Default", assignedTo: actor._id,
    });
    leadIds.push(lead._id);

    // One follow-up in EACH store, both due in the past (mission material).
    const pastDue = new Date(Date.now() - 2 * 3600 * 1000);
    await CallCockpitService.addFollowUp(
      lead._id, { type: "call", scheduledAt: pastDue.toISOString(), promiseNote: "will call back" }, actor._id
    );
    const journeyFu = await FollowupService.create(
      lead._id, { title: "Send the venue shortlist", dueAt: pastDue.toISOString() }, actor._id
    );

    // ── 1. Bridged list: both stores, correct tags + completion routes.
    console.log("1. GET followups returns both stores tagged");
    const list = await FollowupService.listForLead(lead._id);
    ok(list.length === 2, `two rows, one per store (got ${list.length})`);
    const cadence = list.find((r) => r.store === "cadence");
    const journey = list.find((r) => r.store === "journey");
    ok(!!cadence && !!journey, "one cadence row + one journey row");
    ok(cadence && cadence.completeVia === `PUT /enquiry/${lead._id}/follow-up/${cadence._id}/complete`,
      "cadence row carries the lifecycle completion route");
    ok(journey && journey.completeVia === `PATCH /enquiry/${lead._id}/followups/${journey._id}`,
      "journey row carries the followups PATCH route");
    ok(cadence && cadence.overdue === true && journey.overdue === true, "both rows read overdue");

    // ── 2. Mission surfaces BOTH stores.
    console.log("2. Today's Mission shows both stores");
    const dash = await DashboardService.buildDashboard(actor._id, "own", { assignedTo: actor._id });
    const mission = dash.todaysMission.filter((r) => String(r.leadId) === String(lead._id));
    ok(mission.some((r) => r.store === "cadence"), "cadence follow-up in the mission");
    ok(mission.some((r) => r.store === "journey"), "journey follow-up in the mission");
    const jRow = mission.find((r) => r.store === "journey");
    ok(jRow && jRow.title === "Send the venue shortlist" && jRow.overdue === true, "journey row carries its title + red state");

    // ── 3. Completing each via ITS OWN route leaves the other store untouched.
    console.log("3. per-store completion, no cross-store writes");
    await FollowupService.complete(journeyFu._id, actor._id);
    const afterJourney = await Enquiry.findById(lead._id).lean();
    ok(afterJourney.followUps.every((f) => !f.completedAt), "completing the journey row did NOT touch the embedded store");

    await LeadLifecycleService.completeFollowUp(
      lead._id, cadence._id,
      { outcome: "no_answer", durationSeconds: 0 }, // unanswered → cadence suggests next attempt; no next-step needed only at MAX — supply one
      actor._id
    ).catch(async () => {
      // Zero-orphan gate demands exactly one next step on an open lead — retry with one.
      return LeadLifecycleService.completeFollowUp(
        lead._id, cadence._id,
        {
          outcome: "no_answer", durationSeconds: 0,
          nextFollowUp: { type: "call", scheduledAt: new Date(Date.now() + 86400000).toISOString() },
        },
        actor._id
      );
    });
    const afterCadence = await Enquiry.findById(lead._id).lean();
    const completedEmbedded = afterCadence.followUps.find((f) => String(f._id) === String(cadence._id));
    ok(!!completedEmbedded.completedAt, "cadence row completed in the embedded store");
    const journeyDoc = await Followup.findById(journeyFu._id).lean();
    ok(journeyDoc.status === "done", "journey doc still exactly as completed (no cross-write)");

    // ── 4. Mission clears once both are done (fresh next-step excluded: future-dated).
    const dash2 = await DashboardService.buildDashboard(actor._id, "own", { assignedTo: actor._id });
    const mission2 = dash2.todaysMission.filter((r) => String(r.leadId) === String(lead._id));
    ok(mission2.length === 0, "no red rows left for this lead (next attempt is tomorrow)");
  } finally {
    if (leadIds.length) {
      await Followup.deleteMany({ leadId: { $in: leadIds } });
      await LeadInternalEvent.deleteMany({ leadId: { $in: leadIds } });
      await LeadChatMessage.deleteMany({ leadId: { $in: leadIds } });
      await AdminNotification.deleteMany({ leadId: { $in: leadIds } });
      await CalendarEvent.deleteMany({ leadId: { $in: leadIds } });
      await Enquiry.deleteMany({ _id: { $in: leadIds } });
    }
    if (adminIds.length) await Admin.deleteMany({ _id: { $in: adminIds } });
    if (dept) await Department.deleteMany({ _id: dept._id });
    await mongoose.disconnect();
  }

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("Test harness error:", e); process.exit(1); });
