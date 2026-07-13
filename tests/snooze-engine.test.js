/**
 * Slice A2 — THE SNOOZE ENGINE. The follow-up date is the single source of truth.
 *
 *   node tests/snooze-engine.test.js
 *
 * Covers: >threshold snoozes (responded only), <threshold doesn't, pull-in wakes,
 * complete wakes, push-out re-snoozes, unsnooze clears, queue exclusions
 * (respond-now / dashboard missions / rescue / lane-silence sweep), list +
 * schedule presence, once-per-episode wake warn, past-date wake, and the
 * manager `parked` payload with the disabled-owner flag.
 *
 * Seeds uniquely-tagged docs against the local CRM DB; cleans up in finally.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");
const Followup = require("../models/Followup");
const LeadLane = require("../models/LeadLane");
const LaneEntry = require("../models/LaneEntry");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const AdminNotification = require("../models/AdminNotification");
const EscalationMark = require("../models/EscalationMark");
const LeadChatMessage = mongoose.models.LeadChatMessage || null;

const SnoozeService = require("../services/SnoozeService");
const FollowupService = require("../services/FollowupService");
const CallCockpitService = require("../services/CallCockpitService");
const GoldenWindowService = require("../services/GoldenWindowService");
const RescueService = require("../services/RescueService");
const EscalationSweepService = require("../services/EscalationSweepService");
const DashboardService = require("../services/DashboardService");
const SettingsService = require("../services/SettingsService");

const TAG = `snooze-${Date.now()}`;
const DAY_MS = 24 * 3600 * 1000;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const days = (n) => new Date(Date.now() + n * DAY_MS);

const makeLead = (suffix, extra = {}) =>
  Enquiry.create({
    name: `${TAG}-${suffix}`, phone: `${TAG}-${suffix}`, verified: false, isInterested: false,
    isLost: false, stage: "new", source: "Default", lostStatus: "none", ...extra,
  });

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

  const created = { admins: [], leads: [] };
  let dept = null, role = null;
  try {
    // ── People: manager ← owner (report), plus a DISABLED owner ──────────────
    dept = await Department.create({ name: `${TAG}-dept` });
    role = await Role.create({ name: `${TAG}-role`, permissions: [], deletedAt: null, departmentId: dept._id });
    const manager = await Admin.create({
      name: `${TAG}-mgr`, email: `${TAG}-m@x.com`, phone: `${TAG}m`, password: "x",
      roles: ["sales"], status: "active", roleId: role._id, departmentId: dept._id,
    });
    const owner = await Admin.create({
      name: `${TAG}-owner`, email: `${TAG}-o@x.com`, phone: `${TAG}o`, password: "x",
      roles: ["sales"], status: "active", roleId: role._id, departmentId: dept._id,
      reportingManagerId: manager._id,
    });
    const disabledOwner = await Admin.create({
      name: `${TAG}-dis`, email: `${TAG}-d@x.com`, phone: `${TAG}d`, password: "x",
      roles: ["sales"], status: "active", isDisabled: true, roleId: role._id, departmentId: dept._id,
    });
    created.admins.push(manager._id, owner._id, disabledOwner._id);

    // ── 1. Threshold behaviour ────────────────────────────────────────────────
    // A: responded, journey follow-up 45d out → SNOOZES.
    const A = await makeLead("A", { assignedTo: owner._id, firstRespondedAt: new Date() });
    created.leads.push(A._id);
    const fuA = await FollowupService.create(String(A._id), { title: "callback", dueAt: days(45) }, owner._id);
    let a = await Enquiry.findById(A._id).lean();
    ok(a.snoozedUntil && Math.abs(+new Date(a.snoozedUntil) - +days(45)) < 60000,
      ">30d follow-up on a RESPONDED lead snoozes (snoozedUntil = the follow-up date)");
    ok(String(a.snoozeSource) === String(fuA._id), "snoozeSource = the parking follow-up's _id");
    ok(await LeadInternalEvent.exists({ leadId: A._id, type: "lead_snoozed" }), "journey event lead_snoozed recorded");

    // B: UNRESPONDED, same 45d follow-up → never snoozes.
    const B = await makeLead("B", { assignedTo: owner._id, firstRespondedAt: null });
    created.leads.push(B._id);
    await FollowupService.create(String(B._id), { title: "callback", dueAt: days(45) }, owner._id);
    ok(!(await Enquiry.findById(B._id).lean()).snoozedUntil, "unresponded lead NEVER snoozes");

    // C: responded, 21d follow-up → below threshold, no snooze.
    const C = await makeLead("C", { assignedTo: owner._id, firstRespondedAt: new Date() });
    created.leads.push(C._id);
    await FollowupService.create(String(C._id), { title: "callback", dueAt: days(21) }, owner._id);
    ok(!(await Enquiry.findById(C._id).lean()).snoozedUntil, "21d follow-up does NOT snooze");

    // Embedded (cadence) store snoozes too.
    const D = await makeLead("D", { assignedTo: owner._id, firstRespondedAt: new Date() });
    created.leads.push(D._id);
    await CallCockpitService.addFollowUp(String(D._id), { type: "call", scheduledAt: days(40).toISOString() }, owner._id);
    const d1 = await Enquiry.findById(D._id).lean();
    ok(!!d1.snoozedUntil, "embedded cadence follow-up (40d) snoozes via the cockpit write path");

    // ── 2. Pull in → wakes; complete near → re-snoozes; complete far → wakes ──
    await FollowupService.create(String(A._id), { title: "quick check", dueAt: days(2) }, owner._id);
    a = await Enquiry.findById(A._id).lean();
    ok(!a.snoozedUntil, "pulling the earliest date in (2d follow-up added) WAKES the lead");
    ok(await LeadInternalEvent.exists({ leadId: A._id, type: "lead_woken", "payload.reason": "followup_change" }),
      "journey event lead_woken (followup_change) recorded");

    const nearA = await Followup.findOne({ leadId: A._id, title: "quick check" }).lean();
    await FollowupService.complete(String(nearA._id), owner._id);
    a = await Enquiry.findById(A._id).lean();
    ok(!!a.snoozedUntil, "completing the near follow-up pushes the earliest back out → RE-snoozes");

    // Completing the PARKING follow-up (no open follow-ups left) → wakes.
    await FollowupService.complete(String(fuA._id), owner._id);
    a = await Enquiry.findById(A._id).lean();
    ok(!a.snoozedUntil && !a.snoozeSource, "completing the parking follow-up wakes (no open follow-ups left)");

    // ── 3. Unsnooze clears; the follow-up stays ──────────────────────────────
    const fuA2 = await FollowupService.create(String(A._id), { title: "long park", dueAt: days(60) }, owner._id);
    a = await Enquiry.findById(A._id).lean();
    ok(!!a.snoozedUntil, "re-parked for the unsnooze test");
    const un = await SnoozeService.unsnooze(String(A._id), manager._id);
    a = await Enquiry.findById(A._id).lean();
    ok(un.changed && !a.snoozedUntil && !a.snoozeSource, "unsnooze clears both fields");
    ok((await Followup.findById(fuA2._id).lean()).status === "open", "the follow-up itself is untouched (still open)");
    ok(await LeadInternalEvent.exists({ leadId: A._id, type: "lead_woken", "payload.reason": "manual" }),
      "journey event lead_woken (manual) recorded");

    // ── 4. Queue exclusions ───────────────────────────────────────────────────
    // Respond Now: fresh unresponded lead present; force-snoozed → absent.
    const M = await makeLead("M", { assignedTo: owner._id });
    created.leads.push(M._id);
    let rn = await GoldenWindowService.respondNow(String(owner._id));
    ok(rn.rows.some((r) => String(r._id) === String(M._id)), "sanity: fresh unresponded lead IS in Respond Now");
    await Enquiry.collection.updateOne({ _id: M._id }, { $set: { snoozedUntil: days(30) } });
    rn = await GoldenWindowService.respondNow(String(owner._id));
    ok(!rn.rows.some((r) => String(r._id) === String(M._id)), "snoozed lead leaves Respond Now (query + count)");
    await Enquiry.collection.updateOne({ _id: M._id }, { $set: { snoozedUntil: null } });

    // Dashboard missions: unresponsive-decide row disappears while parked.
    const G = await makeLead("G", {
      assignedTo: owner._id, firstRespondedAt: new Date(), stage: "contacted", unresponsiveFlaggedAt: new Date(),
    });
    created.leads.push(G._id);
    let dash = await DashboardService.buildDashboard(String(owner._id), "own", { assignedTo: owner._id });
    ok(dash.unresponsiveDecide.some((r) => String(r.leadId) === String(G._id)),
      "sanity: flagged lead IS in the dashboard unresponsive mission");
    await Enquiry.collection.updateOne({ _id: G._id }, { $set: { snoozedUntil: days(30) } });
    dash = await DashboardService.buildDashboard(String(owner._id), "own", { assignedTo: owner._id });
    ok(!dash.unresponsiveDecide.some((r) => String(r.leadId) === String(G._id)),
      "snoozed lead leaves the dashboard missions");

    // Rescue: breached, uncalled lead in the manager's team scope.
    const N = await makeLead("N", { assignedTo: owner._id });
    created.leads.push(N._id);
    await Enquiry.collection.updateOne({ _id: N._id }, { $set: { createdAt: new Date(Date.now() - 3 * 3600 * 1000) } });
    let rq = await RescueService.rescueQueue(String(manager._id), "team");
    ok(rq.rows.some((r) => String(r._id) === String(N._id)), "sanity: breached lead IS in the rescue queue");
    await Enquiry.collection.updateOne({ _id: N._id }, { $set: { snoozedUntil: days(30), firstRespondedAt: new Date() } });
    rq = await RescueService.rescueQueue(String(manager._id), "team");
    ok(!rq.rows.some((r) => String(r._id) === String(N._id)), "snoozed lead leaves the rescue queue");

    // Lane-silence sweep pauses; wake-pass untouched (lane still on its rules).
    const H = await makeLead("H", { assignedTo: owner._id, firstRespondedAt: new Date() });
    created.leads.push(H._id);
    await LeadLane.create({
      leadId: H._id, key: "decor", name: "Décor", state: "active", ownerId: owner._id,
      lastUpdateAt: new Date(Date.now() - 10 * DAY_MS), createdBy: owner._id,
    });
    await Enquiry.collection.updateOne({ _id: H._id }, { $set: { snoozedUntil: days(30) } });
    let sweep = await EscalationSweepService.runSweep(new Date(), { leadFilter: { _id: { $in: [H._id] } } });
    ok(sweep.laneSilent === 0, "lane-silence ladder PAUSED while the lead is parked");
    await Enquiry.collection.updateOne({ _id: H._id }, { $set: { snoozedUntil: null } });
    sweep = await EscalationSweepService.runSweep(new Date(), { leadFilter: { _id: { $in: [H._id] } } });
    ok(sweep.laneSilent > 0, "same lane RINGS once the lead is no longer parked (clock resumed)");

    // ── 5. Still in the list + the schedule ───────────────────────────────────
    await Enquiry.collection.updateOne({ _id: G._id }, { $set: { snoozedUntil: days(30) } });
    const listDoc = await Enquiry.findOne({ _id: G._id }).lean();
    ok("snoozedUntil" in listDoc && !!listDoc.snoozedUntil,
      "snoozedUntil rides list rows (full-doc list passthrough — chip data present)");
    const schedule = await FollowupService.listForLead(String(A._id));
    ok(schedule.some((r) => String(r._id) === String(fuA2._id) && r.open),
      "the parking follow-up STAYS in the lead's schedule read (wake date = scheduled commitment)");
    const myDue = await FollowupService.myDue(String(owner._id), { withinDays: 90 });
    ok(Array.isArray(myDue), "my-due schedule read unaffected (no snooze exclusion added)");

    // ── 6. Wake sweep: warn once per episode, then wake past the date ────────
    const I = await makeLead("I", { assignedTo: owner._id, firstRespondedAt: new Date() });
    const J = await makeLead("J", { assignedTo: owner._id, firstRespondedAt: new Date() });
    created.leads.push(I._id, J._id);
    await Enquiry.collection.updateOne({ _id: I._id }, { $set: { snoozedUntil: days(2), snoozeSource: new mongoose.Types.ObjectId() } });
    await Enquiry.collection.updateOne({ _id: J._id }, { $set: { snoozedUntil: new Date(Date.now() - DAY_MS), snoozeSource: new mongoose.Types.ObjectId() } });

    let ws = await SnoozeService.wakeSweep(new Date(), { _id: { $in: [I._id, J._id] } });
    ok(ws.warned === 1, `warn fired for the waking lead (got warned=${ws.warned})`);
    ok(ws.woken === 1, `past-date lead woken (got woken=${ws.woken})`);
    const j = await Enquiry.findById(J._id).lean();
    ok(!j.snoozedUntil && !j.snoozeSource, "woken lead's fields cleared — it re-enters every queue naturally");
    ok(await LeadInternalEvent.exists({ leadId: J._id, type: "lead_woken", "payload.reason": "wake_date_reached" }),
      "journey event lead_woken (wake_date_reached) recorded");
    const notif = await AdminNotification.find({ type: "lead_waking", leadId: I._id }).lean();
    ok(notif.length === 1 && /You promised .* a callback on /.test(notif[0].message),
      `owner got the "You promised {name} a callback on {date}" nudge`);

    ws = await SnoozeService.wakeSweep(new Date(), { _id: { $in: [I._id, J._id] } });
    ok(ws.warned === 0, "second sweep: warn does NOT re-fire (once per episode)");
    const notif2 = await AdminNotification.find({ type: "lead_waking", leadId: I._id }).lean();
    ok(notif2.length === 1, "still exactly one lead_waking notification");

    // ── 6b. Single-lead decoration (FE contract: { until, note, waking }) ────
    const aForDeco = await Enquiry.findById(A._id).lean();
    // A is currently UNPARKED (unsnooze) — re-park via a follow-up write.
    await FollowupService.snooze(String(fuA2._id), { until: days(61) }, owner._id);
    const aParked = await Enquiry.findById(A._id).lean();
    const deco = await SnoozeService.decoration(aParked);
    ok(deco && "until" in deco && "note" in deco && "waking" in deco && !("source" in deco),
      "decoration shape is { until, note, waking } (no ObjectId `source`)");
    ok(deco && deco.note === "long park",
      `decoration.note resolves the source follow-up's text (got ${JSON.stringify(deco && deco.note)})`);
    ok(deco && deco.waking === false, "waking=false for a 61d-out wake date");
    const decoNull = await SnoozeService.decoration(aForDeco);
    ok(decoNull === null, "decoration is null for an unparked lead");
    // Cadence-source note: lead D was parked by an embedded call follow-up.
    const dDoc = await Enquiry.findById(D._id).lean();
    const dDeco = await SnoozeService.decoration(dDoc);
    ok(dDeco && dDeco.note === "Call", "cadence-sourced note falls back to the type label");

    // leadRow contract: snoozedUntil (ISO or null) on lifecycle lead rows.
    const rowParked = dash && dash.unresponsiveDecide; // dash built earlier
    const anyDash = await DashboardService.buildDashboard(String(owner._id), "own", { assignedTo: owner._id });
    const someRow = [...anyDash.newUntouched, ...anyDash.unresponsiveDecide][0];
    ok(!someRow || "snoozedUntil" in someRow, "dashboard lead rows carry snoozedUntil (ISO|null)");

    // ── 7. Manager `parked` payload ───────────────────────────────────────────
    const L = await makeLead("L", { assignedTo: disabledOwner._id, firstRespondedAt: new Date() });
    created.leads.push(L._id);
    await Enquiry.collection.updateOne({ _id: L._id }, { $set: { snoozedUntil: days(50) } });
    const mgrDash = await DashboardService.buildDashboard(String(manager._id), "all", {
      assignedTo: { $in: [owner._id, disabledOwner._id] },
    });
    ok(Array.isArray(mgrDash.parked) && mgrDash.parked.length >= 1, "parked payload present on manager scopes");
    const gRow = mgrDash.parked.find((r) => r.leadId === String(G._id));
    const lRow = mgrDash.parked.find((r) => r.leadId === String(L._id));
    ok(gRow && gRow.ownerName === `${TAG}-owner` && gRow.ownerDisabled === false &&
       typeof gRow.wakeAt === "string" && !Number.isNaN(+new Date(gRow.wakeAt)),
      "parked row shape: { leadId, name, ownerName, ownerDisabled:false, wakeAt:ISO } for a live owner");
    ok(gRow && !("owner" in gRow) && !("snoozedUntil" in gRow) && !("month" in gRow),
      "parked rows are FLAT (no owner object / snoozedUntil / month keys — FE contract)");
    ok(lRow && lRow.ownerDisabled === true, "ownerDisabled=true when the owner fails the assignable predicate");
    const wakes = mgrDash.parked.map((r) => +new Date(r.wakeAt));
    ok(JSON.stringify(wakes) === JSON.stringify([...wakes].sort((x, y) => x - y)),
      "parked rows sorted by wakeAt ascending");

    // Settings defaults registered.
    ok((await SettingsService.get("snooze.thresholdDays")) === 30, "snooze.thresholdDays default 30");
    ok((await SettingsService.get("snooze.wakeWarnDays")) === 3, "snooze.wakeWarnDays default 3");

    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    const leadIds = created.leads;
    await Followup.deleteMany({ leadId: { $in: leadIds } }).catch(() => {});
    await LaneEntry.deleteMany({ leadId: { $in: leadIds } }).catch(() => {});
    await LeadLane.deleteMany({ leadId: { $in: leadIds } }).catch(() => {});
    await LeadInternalEvent.deleteMany({ leadId: { $in: leadIds } }).catch(() => {});
    await AdminNotification.deleteMany({ leadId: { $in: leadIds } }).catch(() => {});
    await EscalationMark.deleteMany({ leadId: { $in: leadIds } }).catch(() => {});
    if (mongoose.models.LeadChatMessage) await mongoose.models.LeadChatMessage.deleteMany({ leadId: { $in: leadIds } }).catch(() => {});
    await Enquiry.deleteMany({ _id: { $in: leadIds } }).catch(() => {});
    await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
    if (role) await Role.deleteOne({ _id: role._id }).catch(() => {});
    if (dept) await Department.deleteOne({ _id: dept._id }).catch(() => {});
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
