/**
 * Escalation sweep — Slice B4. Time-travel via the injected `now`; every query
 * scoped to the seeded leads via opts.leadFilter.
 *
 *   node tests/escalation-sweep.test.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");
const LeadLane = require("../models/LeadLane");
const LaneEntry = require("../models/LaneEntry");
const EscalationMark = require("../models/EscalationMark");
const AdminNotification = require("../models/AdminNotification");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const SettingsService = require("../services/SettingsService");
const { runSweep } = require("../services/EscalationSweepService");

const TAG = `sweep-${Date.now()}`;
const DAY = 24 * 60 * 60 * 1000;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

  const leadIds = [], adminIds = [];
  let dept = null, createdRhRole = null, createdFounderRole = null;
  const slaSnapshot = await SettingsService.get("dealclock.qualifiedToMeetingDays");
  try {
    dept = await Department.create({ name: `${TAG}-dept` });
    const mk = (suffix, extra = {}) =>
      Admin.create({ name: `${TAG}-${suffix}`, email: `${TAG}-${suffix}@x.com`, phone: `${TAG}${suffix}`, password: "x", status: "active", departmentId: dept._id, ...extra });

    let rhRole = await Role.findOne({ name: "Revenue Head", deletedAt: null }).lean();
    if (!rhRole) { createdRhRole = await Role.create({ name: "Revenue Head" }); rhRole = createdRhRole; }
    let fRole = await Role.findOne({ name: "Founder", deletedAt: null }).lean();
    if (!fRole) { createdFounderRole = await Role.create({ name: "Founder" }); fRole = createdFounderRole; }

    const leadOwner = await mk("leadowner");
    const laneOwner = await mk("laneowner");
    const revHead = await mk("revhead", { roleIds: [rhRole._id] });
    const founder = await mk("founder", { roleIds: [fRole._id] });
    adminIds.push(leadOwner._id, laneOwner._id, revHead._id, founder._id);

    const now = new Date();
    const mkLead = (suffix, extra = {}) =>
      Enquiry.create({
        name: `Sweep ${suffix}`, phone: `${TAG}-${suffix}`, verified: false, isInterested: false,
        isLost: false, stage: "meeting_scheduled", source: "Default", assignedTo: leadOwner._id,
        qualified: true, qualifiedAt: now, ...extra,
      });

    const leadA = await mkLead("lanes");
    leadIds.push(leadA._id);
    const filter = () => ({ _id: { $in: leadIds } });
    const notifCount = (adminId, type) => AdminNotification.countDocuments({ adminId, type, leadId: { $in: leadIds } });

    // Lanes on lead A: silent-2.5d (owned), unassigned fresh, paused-10d, queued.
    const laneSilent = await LeadLane.create({ leadId: leadA._id, key: "venue", name: "Venue", ownerId: laneOwner._id, state: "active", lastUpdateAt: new Date(+now - 2.5 * DAY) });
    await LeadLane.create({ leadId: leadA._id, key: "makeup", name: "Makeup", ownerId: null, state: "active", lastUpdateAt: new Date(+now - 0.1 * DAY) });
    await LeadLane.create({ leadId: leadA._id, key: "decor", name: "Décor", ownerId: laneOwner._id, state: "paused", pausedReason: "client", lastUpdateAt: new Date(+now - 10 * DAY) });
    await LeadLane.create({ leadId: leadA._id, key: "vendors", name: "Vendors", ownerId: laneOwner._id, state: "queued", wake: { type: "afterLane", laneKey: "venue" }, lastUpdateAt: new Date(+now - 10 * DAY) });
    // A future meet keeps lead A's deal clock quiet (current = meeting_held, meeting ahead).
    await Enquiry.updateOne({ _id: leadA._id }, { $push: { followUps: { type: "meet", scheduledAt: new Date(+now + 2 * DAY), promiseNote: "" } } });

    // ── 1. Rung 1 + unassigned rung 2.
    console.log("1. lane ladder — rungs + exemptions");
    let r = await runSweep(now, { leadFilter: filter() });
    ok(r.laneSilent === 2, `two lane escalations fired (got ${r.laneSilent})`);
    ok((await notifCount(laneOwner._id, "lane_silent")) === 1, "2.5d silent owned lane → rung 1 to the LANE owner");
    ok((await notifCount(leadOwner._id, "lane_silent")) === 1, "unassigned active lane → immediate rung 2 (lead owner)");
    ok((await notifCount(revHead._id, "lane_silent")) === 1, "…and the Revenue Head");
    ok((await notifCount(founder._id, "lane_silent")) === 0, "no founder ring below 6d");

    // Same episode, second sweep → zero new.
    const before = await AdminNotification.countDocuments({ leadId: { $in: leadIds } });
    r = await runSweep(now, { leadFilter: filter() });
    ok(r.laneSilent === 0 && (await AdminNotification.countDocuments({ leadId: { $in: leadIds } })) === before,
      "second sweep, same episode → episode dedupe holds");

    // ── 2. Deeper silence, SAME episode anchor → higher rungs fire once each.
    console.log("2. deeper rungs on the same episode");
    r = await runSweep(new Date(+now + 4.5 * DAY), { leadFilter: filter() });
    ok((await notifCount(leadOwner._id, "lane_silent")) >= 2, "≥4d → lead owner rung 2 for the owned lane");
    r = await runSweep(new Date(+now + 6.5 * DAY), { leadFilter: filter() });
    ok((await notifCount(founder._id, "lane_silent")) >= 1, "≥6d → Founders rung 3");
    // Paused 10d lane never fired.
    const pausedFired = await EscalationMark.countDocuments({ leadId: leadA._id, key: { $regex: ":decor:" } });
    ok(pausedFired === 0, "paused lane exempt despite 10d silence");
    const queuedFired = await EscalationMark.countDocuments({ leadId: leadA._id, key: { $regex: ":vendors:" } });
    ok(queuedFired === 0, "queued lane exempt from the silence ladder");

    // ── 3. Deal clock — qualified→meeting_set over SLA (3d default).
    console.log("3. deal clock");
    const leadB = await mkLead("dealclock", { stage: "contacted", qualifiedAt: new Date(+now - 5 * DAY) });
    leadIds.push(leadB._id);
    r = await runSweep(now, { leadFilter: { _id: leadB._id } });
    ok(r.dealStalled === 2, `5d in meeting_set (SLA 3d, 2d over) → rungs 1+2 (got ${r.dealStalled})`);
    ok((await notifCount(leadOwner._id, "deal_stalled")) >= 1, "lead owner rung 1");
    ok((await notifCount(revHead._id, "deal_stalled")) >= 1, "Revenue Head rung 2 at SLA+2d");
    ok((await AdminNotification.countDocuments({ adminId: founder._id, type: "deal_stalled", leadId: leadB._id })) === 0, "no founder below SLA+4d");
    r = await runSweep(now, { leadFilter: { _id: leadB._id } });
    ok(r.dealStalled === 0, "deal-clock episode dedupe holds");

    // Settings override: SLA 10d → a fresh 5d lead does NOT fire.
    await SettingsService.set("dealclock.qualifiedToMeetingDays", 10);
    const leadC = await mkLead("slaoverride", { stage: "contacted", qualifiedAt: new Date(+now - 5 * DAY) });
    leadIds.push(leadC._id);
    r = await runSweep(now, { leadFilter: { _id: leadC._id } });
    ok(r.dealStalled === 0, "settings override respected (10d SLA, 5d in station → quiet)");
    await SettingsService.set("dealclock.qualifiedToMeetingDays", slaSnapshot);

    // Meeting past its slot, unclosed → immediate rung 1.
    const leadD = await mkLead("pastmeet", {
      followUps: [{ type: "meet", scheduledAt: new Date(+now - 1 * DAY), promiseNote: "" }],
    });
    leadIds.push(leadD._id);
    r = await runSweep(now, { leadFilter: { _id: leadD._id } });
    ok(r.dealStalled >= 1, "past-scheduledAt unclosed meeting → immediate rung 1");

    // ── 4. Wake pass.
    console.log("4. wake pass");
    await LeadLane.updateOne({ leadId: leadA._id, key: "venue" }, { $set: { state: "done", doneAt: new Date() } });
    const onDate = await LeadLane.create({ leadId: leadA._id, key: "engagement", name: "Client engagement", ownerId: laneOwner._id, state: "queued", wake: { type: "onDate", at: new Date(+now - 3600e3) }, lastUpdateAt: new Date(+now - 5 * DAY) });
    r = await runSweep(now, { leadFilter: filter() });
    ok(r.woken === 2, `afterLane (venue done) + onDate both woke (got ${r.woken})`);
    const vendors = await LeadLane.findOne({ leadId: leadA._id, key: "vendors" }).lean();
    ok(vendors.state === "active" && vendors.wake == null && +new Date(vendors.lastUpdateAt) === +now, "woken lane active, wake cleared, heartbeat reset to now");
    ok((await LaneEntry.countDocuments({ leadId: leadA._id, autoType: "lane_woken" })) === 2, "lane_woken auto entries written");
    ok((await notifCount(laneOwner._id, "lane_woken")) === 2, "woken-lane owners notified");
    ok((await LeadLane.findById(onDate._id).lean()).state === "active", "onDate lane active");
  } finally {
    if (leadIds.length) {
      await LaneEntry.deleteMany({ leadId: { $in: leadIds } });
      await LeadLane.deleteMany({ leadId: { $in: leadIds } });
      await EscalationMark.deleteMany({ leadId: { $in: leadIds } });
      await AdminNotification.deleteMany({ leadId: { $in: leadIds } });
      await LeadInternalEvent.deleteMany({ leadId: { $in: leadIds } });
      await Enquiry.deleteMany({ _id: { $in: leadIds } });
    }
    if (adminIds.length) await Admin.deleteMany({ _id: { $in: adminIds } });
    if (createdRhRole) await Role.deleteMany({ _id: createdRhRole._id });
    if (createdFounderRole) await Role.deleteMany({ _id: createdFounderRole._id });
    if (dept) await Department.deleteMany({ _id: dept._id });
    await SettingsService.set("dealclock.qualifiedToMeetingDays", slaSnapshot);
    await mongoose.disconnect();
  }

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("Test harness error:", e); process.exit(1); });
