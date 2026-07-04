/**
 * Mid-qualify backend slice — three additive pieces:
 *   1. callLog[].purpose ("" | discovery | follow_up): accepted by logCall,
 *      stamped "follow_up" by completeFollowUp's call-shaped branch, legacy
 *      rows read "" and keep the old journey label.
 *   2. discovery.state (not_started | in_progress | complete), computed on
 *      read in DiscoveryService — no storage, no new queries.
 *   3. sourceChannel (website | instagram | whatsapp | ads | other), derived
 *      from the messy stored source text via the shared matcher — the stored
 *      text is never rewritten.
 *
 *   node tests/mid-qualify-slice.test.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Department = require("../models/Department");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const CalendarEvent = require("../models/CalendarEvent");
const CallCockpitService = require("../services/CallCockpitService");
const LeadLifecycleService = require("../services/LeadLifecycleService");
const { computeDiscovery } = require("../services/DiscoveryService");
const { buildJourney } = require("../services/JourneyService");
const { sourceChannelOf } = require("../utils/leadSource");

const TAG = `midq-${Date.now()}`;
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
      name: "Midq Lead", phone: `${TAG}`, verified: false, isInterested: false,
      isLost: false, stage: "contacted", source: "Default", assignedTo: actor._id,
    });
    leadIds.push(lead._id);

    // ── 1. purpose ─────────────────────────────────────────────────────────
    console.log("1. callLog purpose");
    await CallCockpitService.logCall(
      lead._id,
      { startedAt: new Date().toISOString(), durationSeconds: 60, connected: true, outcome: "", purpose: "discovery", notes: "" },
      actor._id
    );
    let doc = await Enquiry.findById(lead._id).lean();
    ok(doc.callLog[0].purpose === "discovery", "purpose accepted + persisted on the entry");

    // Invalid purpose → 400, nothing written.
    let rejected = false;
    try {
      await CallCockpitService.logCall(
        lead._id,
        { startedAt: new Date().toISOString(), durationSeconds: 0, connected: false, outcome: "", purpose: "sales" },
        actor._id
      );
    } catch (e) { rejected = e.status === 400; }
    ok(rejected, "invalid purpose rejected with 400");

    // completeFollowUp's call-shaped branch stamps follow_up.
    const past = new Date(Date.now() - 3600 * 1000);
    await CallCockpitService.addFollowUp(lead._id, { type: "call", scheduledAt: past.toISOString() }, actor._id);
    doc = await Enquiry.findById(lead._id).lean();
    const openFu = doc.followUps.find((f) => !f.completedAt);
    await LeadLifecycleService.completeFollowUp(
      lead._id, openFu._id,
      { outcome: "no_answer", durationSeconds: 0, nextFollowUp: { type: "call", scheduledAt: new Date(Date.now() + 86400000).toISOString() } },
      actor._id
    );
    doc = await Enquiry.findById(lead._id).lean();
    const lastCall = doc.callLog[doc.callLog.length - 1];
    ok(lastCall.purpose === "follow_up", "completeFollowUp stamps purpose follow_up on its call-log append");

    // Legacy row (no purpose) reads "" and keeps the old journey label.
    await Enquiry.updateOne(
      { _id: lead._id },
      { $push: { callLog: { startedAt: new Date(), durationSeconds: 5, connected: true, outcome: "", notes: "legacy row" } } }
    );
    doc = await Enquiry.findById(lead._id).lean();
    const legacy = doc.callLog[doc.callLog.length - 1];
    ok((legacy.purpose || "") === "", 'legacy row reads purpose ""');

    const journey = await buildJourney(lead._id);
    const callTitles = journey.entries.filter((e) => e.type === "call").map((e) => e.title);
    ok(callTitles.some((t) => t.startsWith("Discovery call — ")), "journey renders 'Discovery call — …' for typed rows");
    ok(callTitles.some((t) => t.startsWith("Follow-up call — ")), "journey renders 'Follow-up call — …'");
    ok(callTitles.some((t) => t.startsWith("Call — ")), "legacy rows keep the plain 'Call — …' label");

    // ── 2. discovery.state ─────────────────────────────────────────────────
    console.log("2. discovery.state transitions");
    const untouched = { name: "X", qualificationData: {}, callLog: [] };
    ok(computeDiscovery(untouched).discovery.state === "not_started", "untouched lead → not_started");
    ok(computeDiscovery({ qualificationData: { city: "Bengaluru" }, callLog: [] }).discovery.state === "in_progress",
      "one qualification field → in_progress");
    ok(computeDiscovery({ qualificationData: {}, callLog: [{ startedAt: new Date() }] }).discovery.state === "in_progress",
      "one logged call → in_progress");
    ok(computeDiscovery({ qualificationData: { whatsappSameNumber: false, emailNotWilling: false }, callLog: [] }).discovery.state === "not_started",
      "false booleans (schema defaults) do NOT count as captured");
    const gated = computeDiscovery({
      qualificationData: { eventDate: "2026-11-20", servicesRequired: ["decor"] }, callLog: [],
    });
    ok(gated.discovery.state === "complete" && gated.discoveryComplete === true, "gate met → complete (gate unchanged)");
    // The seeded lead (calls logged, no gate fields) reads in_progress end-to-end.
    ok(computeDiscovery(doc).discovery.state === "in_progress", "seeded lead with calls → in_progress");

    // ── 3. sourceChannel mapping (the real messy recon values) ─────────────
    console.log("3. sourceChannel mapping");
    const cases = [
      ["Website", "website"],
      ["Landing Screen", "website"],
      ["Wedding Requirements Form", "website"],
      ["Default", "website"],
      ["Instagram", "instagram"],
      ["Instagram DM", "instagram"],
      ["instagram", "instagram"],
      ["whatsapp", "whatsapp"],
      ["kiara", "whatsapp"],
      ["Landing Screen | Ads (Google & Facebook)", "ads"],
      ["Ads (Landing Screen)", "ads"],
      ["Google Ads", "ads"],
      ["Admin Dashboard", "other"],
      ["User Signup (Account Creation)", "other"],
      ["", "other"],
    ];
    for (const [input, expected] of cases) {
      const got = sourceChannelOf(input);
      ok(got === expected, `"${input || "(empty)"}" → ${expected}${got !== expected ? ` (got ${got})` : ""}`);
    }
    // Stored text is never rewritten.
    ok((await Enquiry.findById(lead._id).lean()).source === "Default", "stored source text untouched");
  } finally {
    if (leadIds.length) {
      await LeadInternalEvent.deleteMany({ leadId: { $in: leadIds } });
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
