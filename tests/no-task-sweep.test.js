// C5 — NO-TASK AUTO-FLAG test. Run: node tests/no-task-sweep.test.js
// Covers: a zero-task owned active lane flags (rung 1 → owner), day-2
// escalation (rung 2 → lead owner + Revenue Head, not the lane owner),
// episode dedupe across sweeps, task creation clears the flag on the next
// pass, and completing that task later starts a FRESH episode (new anchor).
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");
const LeadLane = require("../models/LeadLane");
const LeadTask = require("../models/LeadTask");
const EscalationMark = require("../models/EscalationMark");
const AdminNotification = require("../models/AdminNotification");
const NoTaskService = require("../services/NoTaskService");

const TAG = `notask-${Date.now()}`;
const DAY = 24 * 60 * 60 * 1000;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { leads: [], admins: [], roles: [], depts: [], lanes: [], tasks: [] };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const now = new Date();

    const dept = await Department.create({ name: `${TAG}-dept`, slug: `${TAG}-d` });
    created.depts.push(dept._id);
    const icRole = await Role.create({ name: `${TAG}-ic`, departmentId: dept._id, permissions: ["leads:view:own"] });
    created.roles.push(icRole._id);
    let rhRole = await Role.findOne({ name: "Revenue Head", deletedAt: null });
    if (!rhRole) {
      rhRole = await Role.create({ name: "Revenue Head", departmentId: dept._id, permissions: ["leads:view:team"], description: TAG });
      created.roles.push(rhRole._id);
    }
    const mkAdmin = (s, roleId, extra = {}) =>
      Admin.create({ name: `${TAG}-${s}`, email: `${TAG}-${s}@x.com`, phone: `${TAG}${s}`, password: "x", roles: ["sales"], status: "active", roleId, departmentId: dept._id, ...extra });
    const laneOwner = await mkAdmin("laneowner", icRole._id);
    const leadOwner = await mkAdmin("leadowner", icRole._id);
    const rh = await mkAdmin("rh", rhRole._id);
    created.admins.push(laneOwner._id, leadOwner._id, rh._id);

    const lead = await Enquiry.create({
      name: `${TAG}-lead`, phone: `${TAG}-ph`, verified: false, isInterested: false,
      isLost: false, stage: "contacted", source: "Default", lostStatus: "none", assignedTo: leadOwner._id,
    });
    created.leads.push(lead._id);
    const lane = await LeadLane.create({ leadId: lead._id, key: "planning", name: "Planning", state: "active", ownerId: laneOwner._id });
    created.lanes.push(lane._id);
    // Backdate the lane 3 days (driver-level — createdAt is immutable in mongoose).
    await LeadLane.collection.updateOne({ _id: lane._id }, { $set: { createdAt: new Date(+now - 3 * DAY) } });

    const filter = { _id: { $in: [lead._id] } };
    const notifCount = (adminId, rung) =>
      AdminNotification.countDocuments({ adminId, type: "no_task", leadId: lead._id, "payload.rung": rung });

    // ── first sweep: rung 1 (owner) AND rung 2 (day 2+ anchor) fire ──
    const s1 = await NoTaskService.sweepNoTask(now, filter);
    ok(s1.flagged === 1, `zero-task lane flags (${s1.flagged})`);
    ok(s1.rung1 === 1 && (await notifCount(laneOwner._id, 1)) === 1, "rung 1 notifies the lane owner");
    ok(s1.rung2 === 1, "3d-old anchor escalates to rung 2 in the same pass");
    ok((await notifCount(leadOwner._id, 2)) === 1, "rung 2 notifies the lead owner");
    ok((await notifCount(rh._id, 2)) === 1, "rung 2 notifies the Revenue Head");
    ok((await notifCount(laneOwner._id, 2)) === 0, "the lane owner is NOT double-notified at rung 2");

    // ── episode dedupe: second sweep adds nothing ──
    const s2 = await NoTaskService.sweepNoTask(now, filter);
    ok(s2.flagged === 1 && s2.rung1 === 0 && s2.rung2 === 0, "second sweep re-notifies nothing (episode dedupe)");
    ok((await notifCount(laneOwner._id, 1)) === 1 && (await notifCount(leadOwner._id, 2)) === 1, "notification counts unchanged");

    // ── adding a task clears the flag on the next pass ──
    const task = await LeadTask.create({ leadId: lead._id, title: `${TAG} do the thing`, assigneeId: laneOwner._id, assignerId: leadOwner._id, status: "open", dueAt: now });
    created.tasks.push(task._id);
    const s3 = await NoTaskService.sweepNoTask(now, filter);
    ok(s3.flagged === 0, "an open task clears the flag next pass");

    // ── completing the task later starts a FRESH episode ──
    await LeadTask.updateOne({ _id: task._id }, { $set: { status: "done", completedAt: now } });
    const s4 = await NoTaskService.sweepNoTask(now, filter);
    ok(s4.flagged === 1 && s4.rung1 === 1, "completing the task re-opens a NEW episode (new anchor → rung 1 fires again)");
    ok((await notifCount(laneOwner._id, 1)) === 2, "owner notified once per episode");
    ok(s4.rung2 === 0, "fresh episode has a fresh clock — no day-2 escalation yet");
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    await EscalationMark.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await AdminNotification.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await LeadTask.deleteMany({ _id: { $in: created.tasks } }).catch(() => {});
    await LeadLane.deleteMany({ _id: { $in: created.lanes } }).catch(() => {});
    await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
    await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
    await Role.deleteMany({ _id: { $in: created.roles } }).catch(() => {});
    await Department.deleteMany({ _id: { $in: created.depts } }).catch(() => {});
    await mongoose.disconnect();
    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
