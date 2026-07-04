/**
 * Journey dedupe — one action must render exactly ONE journey entry.
 *
 * The cockpit writes BOTH a raw embedded row (callLog[] / followUps[]) AND a
 * mirroring LeadInternalEvent (call_logged / follow_up_scheduled /
 * follow_up_completed). buildJourney used to emit both, so every call and
 * cockpit follow-up appeared twice. The fix skips the mirroring event types and
 * renders those moments from the raw rows only (they carry strictly more
 * detail). COLLECTION follow-up events (followup_created/followup_completed)
 * have no embedded row and must still render.
 *
 *   node tests/fix-journey-dedupe.test.js
 *
 * Seeds an isolated, uniquely-tagged Enquiry against the local CRM DB and
 * cleans up (lead + its events) in finally.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const CallCockpitService = require("../services/CallCockpitService");
const LeadInternalEventService = require("../services/LeadInternalEventService");
const JourneyService = require("../services/JourneyService");

const TAG = `journey-dedupe-${Date.now()}`;
let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.error(`  ✗ ${label}`); }
};

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

  const actorId = new mongoose.Types.ObjectId();
  let leadId = null;
  try {
    const lead = await Enquiry.create({
      name: "Journey Dedupe Lead",
      phone: `${TAG}`,
      verified: false,
      isInterested: false,
      isLost: false,
      stage: "contacted",
      source: "Default",
    });
    leadId = lead._id;

    console.log("Journey dedupe — cockpit call + follow-up render once each");

    // 1. Cockpit call: raw callLog row + mirroring call_logged event.
    await CallCockpitService.logCall(
      leadId,
      { startedAt: new Date().toISOString(), durationSeconds: 90, connected: true, outcome: "", notes: "spoke briefly" },
      actorId
    );

    // 2. Cockpit follow-up: raw embedded followUps row + mirroring follow_up_scheduled event.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await CallCockpitService.addFollowUp(
      leadId,
      { type: "call", scheduledAt: tomorrow.toISOString(), promiseNote: "will send options" },
      actorId
    );

    // 3. Simulate a lifecycle completion: raw completedAt on the subdoc + the
    //    mirroring follow_up_completed event (exactly what completeFollowUp writes).
    const withFu = await Enquiry.findById(leadId).lean();
    const fuId = withFu.followUps[0]._id;
    await Enquiry.updateOne(
      { _id: leadId, "followUps._id": fuId },
      { $set: { "followUps.$.completedAt": new Date(), "followUps.$.completedBy": actorId, "followUps.$.completedOutcome": "connected" } }
    );
    await LeadInternalEventService.record({
      leadId,
      type: "follow_up_completed",
      actorId,
      payload: { followUpId: String(fuId), outcome: "connected", nextAction: null },
    });

    // 4. A COLLECTION-store follow-up event (no embedded row) — must still render.
    await LeadInternalEventService.record({
      leadId,
      type: "followup_created",
      actorId,
      payload: { followupId: String(new mongoose.Types.ObjectId()), title: "Send venue shortlist", ownerName: "Asha" },
    });

    // Sanity: the mirroring events really exist in the DB (the dedupe is a
    // RENDER-side skip, not a write-side change).
    const mirrored = await LeadInternalEvent.find({
      leadId,
      type: { $in: ["call_logged", "follow_up_scheduled", "follow_up_completed"] },
    }).lean();
    ok(mirrored.length === 3, "precondition: all three mirroring events exist in the DB");

    const journey = await JourneyService.buildJourney(leadId);
    const byType = (t) => journey.entries.filter((e) => e.type === t);

    // Raw rows render once each.
    ok(byType("call").length === 1, 'exactly one "call" entry (from callLog[])');
    ok(byType("follow_up_created").length === 1, 'exactly one "follow_up_created" entry (from followUps[])');
    ok(byType("follow_up_done").length === 1, 'exactly one "follow_up_done" entry (from followUps[].completedAt)');

    // The mirroring events are skipped.
    ok(byType("call_logged").length === 0, "no duplicate call_logged event entry");
    ok(byType("follow_up_scheduled").length === 0, "no duplicate follow_up_scheduled event entry");
    ok(byType("follow_up_completed").length === 0, "no duplicate follow_up_completed event entry");

    // Collection-store follow-up events still render (they have no raw row).
    ok(byType("followup_created").length === 1, "collection followup_created event still renders");

    // The birth entry survives untouched.
    ok(byType("created").length === 1, 'the "created" birth entry is present');
  } finally {
    if (leadId) {
      await LeadInternalEvent.deleteMany({ leadId });
      await Enquiry.deleteMany({ _id: leadId });
    }
    await mongoose.disconnect();
  }

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("Test harness error:", e);
  process.exit(1);
});
