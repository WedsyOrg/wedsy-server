// CREATE-PATH / RE-ENQUIRY notification test.
// Run: node tests/create-path-notification.test.js
//
// Proves the notify-flag routing end to end through the REAL call chain
// (no direct reassignOwner calls — these drive the actual entry points):
//
//   A) LeadIntakeService.afterCreate → assignLead({notify:false}) → reassignOwner
//      A newly created, auto-assigned lead must produce EXACTLY ONE notification
//      — `new_lead` — not two (new_lead + assignment) and not zero.
//
//   B) LeadIntakeService.recordReEnquiry → assignLead() [default notify:true]
//      A recycled lead resurfaced by a re-enquiry must produce its `assignment`
//      notification to the newly picked owner.
//
// Mutates GLOBAL assignment settings — snapshots + restores them in finally
// (the established rig pattern from auto-assign-exclusions.test.js).
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");
const AdminNotification = require("../models/AdminNotification");
const SettingsService = require("../services/SettingsService");
const LeadIntakeService = require("../services/LeadIntakeService");

const TAG = `createpath-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { leads: [], admins: [], roles: [], depts: [] };
const SETTING_KEYS = [
  "assignment.poolRoles", "assignment.overflowRoles", "assignment.excludedAdminIds",
  "assignment.autoAssignEnabled", "assignment.mode",
];
let saved = {};

const allRows = (leadId) => AdminNotification.find({ leadId }).lean();

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    saved = await SettingsService.getMany(SETTING_KEYS);

    const dept = await Department.create({ name: `${TAG}-dept`, slug: `${TAG}-d` });
    created.depts.push(dept._id);
    const role = await Role.create({ name: `${TAG}-pool`, departmentId: dept._id, permissions: ["leads:view:own"] });
    created.roles.push(role._id);

    // A single pool member, so the round-robin pick is deterministic.
    const pool = await Admin.create({
      name: `${TAG}-pool1`, email: `${TAG}p1@x.com`, phone: `${TAG}p1`, password: "x",
      roles: ["sales"], status: "active", roleId: role._id, lastAssignedAt: new Date("2026-01-01"),
    });
    // Inactive — used as the recycled lead's original owner so the resurface
    // falls through to the round-robin branch (the one that calls assignLead).
    const goneOwner = await Admin.create({
      name: `${TAG}-gone`, email: `${TAG}g@x.com`, phone: `${TAG}g`, password: "x",
      roles: ["sales"], status: "inactive",
    });
    created.admins.push(pool._id, goneOwner._id);

    await SettingsService.set("assignment.poolRoles", [`${TAG}-pool`], null);
    await SettingsService.set("assignment.overflowRoles", [`${TAG}-pool`], null);
    await SettingsService.set("assignment.excludedAdminIds", [], null);
    await SettingsService.set("assignment.autoAssignEnabled", true, null);
    await SettingsService.set("assignment.mode", "auto", null);

    // ── A. Newly created + auto-assigned → exactly ONE row, type new_lead ────
    const fresh = await Enquiry.create({
      name: `${TAG}-fresh`, phone: `${TAG}-fresh`, verified: false, isInterested: false,
      isLost: false, stage: "new", source: "Website", lostStatus: "none", assignedTo: null,
      additionalInfo: {},
    });
    created.leads.push(fresh._id);

    await LeadIntakeService.afterCreate(fresh._id);

    const afterFresh = await Enquiry.findById(fresh._id).lean();
    ok(
      afterFresh.assignedTo && String(afterFresh.assignedTo) === String(pool._id),
      "create path actually auto-assigned the lead (the chain ran)"
    );

    const freshRows = await allRows(fresh._id);
    ok(freshRows.length === 1, `newly created auto-assigned lead -> EXACTLY ONE notification (got ${freshRows.length})`);
    ok(freshRows.length === 1 && freshRows[0].type === "new_lead", 'the single row is type "new_lead"');
    ok(
      freshRows.filter((r) => r.type === "assignment").length === 0,
      'no "assignment" row on the create path (notify:false suppressed the duplicate)'
    );
    ok(
      freshRows.length === 1 && String(freshRows[0].adminId) === String(pool._id),
      "the new_lead row went to the auto-assigned owner"
    );

    // ── B. Re-enquiry resurface via assignLead (default notify:true) ─────────
    const recycled = await Enquiry.create({
      name: `${TAG}-recycled`, phone: `${TAG}-recycled`, verified: false, isInterested: false,
      isLost: false, stage: "contacted", source: "Website", lostStatus: "none",
      assignedTo: goneOwner._id, additionalInfo: {},
      recycled: {
        isRecycled: true, reason: "wedding_next_year",
        revisitAt: new Date("2027-01-01"), originalOwnerId: goneOwner._id,
      },
    });
    created.leads.push(recycled._id);

    await LeadIntakeService.recordReEnquiry(recycled._id, { source: "whatsapp", message: "we're back" });

    const afterRecycled = await Enquiry.findById(recycled._id).lean();
    ok(
      afterRecycled.recycled.isRecycled === false,
      "re-enquiry resurfaced the recycled lead (the chain ran)"
    );
    ok(
      afterRecycled.assignedTo && String(afterRecycled.assignedTo) === String(pool._id),
      "resurface fell through to the round-robin (original owner inactive)"
    );

    const recycledRows = await allRows(recycled._id);
    const assignmentRows = recycledRows.filter((r) => r.type === "assignment");
    ok(assignmentRows.length === 1, `re-enquiry resurface -> exactly one "assignment" notification (got ${assignmentRows.length})`);
    ok(
      assignmentRows.length === 1 && String(assignmentRows[0].adminId) === String(pool._id),
      "the assignment row went to the newly picked owner"
    );
    ok(
      assignmentRows.length === 1 && assignmentRows[0].payload.reason === "auto_assign",
      "assignment row carries reason auto_assign (came through the choke-point)"
    );
    ok(
      recycledRows.filter((r) => r.type === "new_lead").length === 0,
      "no new_lead row on a resurface (it is not a create)"
    );

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error("FATAL:", e);
    fail++;
  } finally {
    for (const [k, v] of Object.entries(saved)) await SettingsService.set(k, v, null).catch(() => {});
    await AdminNotification.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
    await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
    await Role.deleteMany({ _id: { $in: created.roles } }).catch(() => {});
    await Department.deleteMany({ _id: { $in: created.depts } }).catch(() => {});
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
