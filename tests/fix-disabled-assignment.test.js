/**
 * Disabled admins must not leak into assignment pools — the shared
 * `assignableFilter` predicate + write-side guards + orphan surfacing.
 *
 *   node tests/fix-disabled-assignment.test.js
 *
 * The Disable button writes ONLY isDisabled (status stays "active"). This test
 * seeds a DISABLED admin whose lastAssignedAt is null (so it would sort FIRST in
 * the round-robin if the filter were broken) alongside an enabled peer, and
 * verifies every selector excludes the disabled one. Uniquely-tagged docs against
 * the local CRM DB; cleaned up in finally.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");
const Enquiry = require("../models/Enquiry");
const LeadLane = require("../models/LeadLane");
const LaneEntry = require("../models/LaneEntry");

const AdminRepository = require("../repositories/AdminRepository");
const {
  assignableFilter,
  filterAssignableIds,
  isAssignableAdmin,
} = require("../utils/assignable");
const LeadAssignmentService = require("../services/LeadAssignmentService");
const AdminService = require("../services/AdminService");
const EnquiryService = require("../services/EnquiryService");
const LeadLifecycleService = require("../services/LeadLifecycleService");
const TriageService = require("../services/TriageService");
const LeadLaneService = require("../services/LeadLaneService");
const SettingsService = require("../services/SettingsService");
const { getDepartmentMemberIds } = require("../middlewares/requirePermission");

const TAG = `dis-assign-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => {
  if (c) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.error(`  ✗ ${label}`); }
};
const has = (arr, id) => arr.map(String).includes(String(id));
const throws422 = async (fn) => {
  try { await fn(); return false; }
  catch (e) { return e && e.status === 422; }
};

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

  const created = { admins: [], leads: [], lanes: [] };
  let dept = null, role = null;
  // Preserve settings we override so the dev DB is left as we found it.
  const savedPoolRoles = await SettingsService.get("assignment.poolRoles");
  const savedOverflow = await SettingsService.get("assignment.overflowRoles");
  const savedAuto = await SettingsService.get("assignment.autoAssignEnabled");
  const savedMode = await SettingsService.get("assignment.mode");

  try {
    dept = await Department.create({ name: `${TAG}-dept` });
    role = await Role.create({ name: `${TAG}-role`, permissions: [], deletedAt: null, departmentId: dept._id });

    // Enabled peer: assignable. lastAssignedAt in the past.
    const enabled = await Admin.create({
      name: `${TAG}-enabled`, email: `${TAG}-en@x.com`, phone: `${TAG}en`,
      password: "x", status: "active", isDisabled: false,
      roleId: role._id, departmentId: dept._id,
      lastAssignedAt: new Date("2020-01-01T00:00:00Z"),
    });
    // Disabled admin: status STILL "active" (the real Disable state), isDisabled true.
    // lastAssignedAt null → sorts FIRST in round-robin if the filter is broken.
    const disabled = await Admin.create({
      name: `${TAG}-disabled`, email: `${TAG}-di@x.com`, phone: `${TAG}di`,
      password: "x", status: "active", isDisabled: true,
      roleId: role._id, departmentId: dept._id,
      reportingManagerId: enabled._id,
      lastAssignedAt: null,
    });
    created.admins.push(enabled._id, disabled._id);

    // Point the round-robin/triage pool at ONLY our test role, so real admins in
    // the dev DB don't interfere.
    await SettingsService.set("assignment.poolRoles", [role.name]);
    // Overflow can't be empty; point it at a non-existent role so only our role matters.
    await SettingsService.set("assignment.overflowRoles", [`${TAG}-none`]);
    await SettingsService.set("assignment.autoAssignEnabled", true);
    await SettingsService.set("assignment.mode", "auto");

    // ── 0. The predicate + helpers ──────────────────────────────────────────
    ok(assignableFilter().isDisabled && assignableFilter().status === "active",
      "assignableFilter gates status:active AND isDisabled:$ne:true");
    const liveIds = await filterAssignableIds([enabled._id, disabled._id]);
    ok(has(liveIds, enabled._id) && !has(liveIds, disabled._id),
      "filterAssignableIds keeps enabled, drops disabled");
    ok((await isAssignableAdmin(enabled._id)) === true, "isAssignableAdmin(enabled) → true");
    ok((await isAssignableAdmin(disabled._id)) === false, "isAssignableAdmin(disabled) → false");

    // ── 1. Round-robin pool (pickAssignee) ──────────────────────────────────
    // Disabled sorts first (null lastAssignedAt) — a correct filter still returns enabled.
    const picked = await LeadAssignmentService.pickAssignee();
    ok(picked && String(picked._id) === String(enabled._id),
      "round-robin pickAssignee returns the ENABLED admin, never the disabled one");

    // ── 2. Triage pool (internsWithStatus) ──────────────────────────────────
    const interns = await TriageService.internsWithStatus();
    ok(has(interns.map((i) => i._id), enabled._id) && !has(interns.map((i) => i._id), disabled._id),
      "triage pool excludes disabled, includes enabled");

    // ── 3. Assignee dropdown (listAdmins assignableOnly) vs management list ──
    const dropdown = await AdminService.listAdmins(null, { assignableOnly: true });
    ok(has(dropdown.map((a) => a._id), enabled._id) && !has(dropdown.map((a) => a._id), disabled._id),
      "listAdmins(assignableOnly) dropdown excludes disabled");
    const mgmt = await AdminRepository.findAll();
    ok(has(mgmt.map((a) => a._id), disabled._id),
      "AdminRepository.findAll (management list) STILL includes disabled (re-enable path intact)");

    // ── 4. Scope helpers (BFS) exclude disabled ─────────────────────────────
    const subs = await AdminRepository.findByReportingManagerIds([enabled._id]);
    ok(!has(subs.map((s) => s._id), disabled._id),
      "findByReportingManagerIds (team BFS) drops disabled report");
    const deptMembers = await getDepartmentMemberIds(dept._id);
    ok(has(deptMembers, enabled._id) && !has(deptMembers, disabled._id),
      "getDepartmentMemberIds excludes disabled, includes enabled");

    // ── 5. Write-side guards: assign + transfer to disabled → 422 ────────────
    const lead = await Enquiry.create({
      name: "Guard Couple", phone: `${TAG}-lead1`, verified: false, isInterested: false,
      isLost: false, stage: "new", source: "Default", lostStatus: "none",
    });
    created.leads.push(lead._id);

    ok(await throws422(() => EnquiryService.updateAssignedTo(String(lead._id), String(disabled._id), null)),
      "updateAssignedTo(disabled) → 422");
    const okAssign = await EnquiryService.updateAssignedTo(String(lead._id), String(enabled._id), null);
    ok(okAssign && String(okAssign.assignedTo) === String(enabled._id),
      "updateAssignedTo(enabled) succeeds");

    ok(await throws422(() => LeadLifecycleService.bulkTransfer(
      { leadIds: [String(lead._id)], toAdminId: String(disabled._id) }, null, {})),
      "bulkTransfer(disabled) → 422");
    const okTransfer = await LeadLifecycleService.bulkTransfer(
      { leadIds: [String(lead._id)], toAdminId: String(enabled._id) }, null, {});
    ok(okTransfer && okTransfer.transferred === 1, "bulkTransfer(enabled) succeeds");

    // ── 6. Lane owner guard: client-chosen disabled owner dropped to null ────
    const laneLead = await Enquiry.create({
      name: "Lane Couple", phone: `${TAG}-lead2`, verified: false, isInterested: false,
      isLost: false, stage: "new", source: "Default", lostStatus: "none",
    });
    created.leads.push(laneLead._id);
    await LeadLaneService.assemble(String(laneLead._id),
      { lanes: [{ key: "decor", ownerId: String(disabled._id) }] }, null);
    const decorLane = await LeadLane.findOne({ leadId: laneLead._id, key: "decor" }).lean();
    if (decorLane) created.lanes.push(decorLane._id);
    ok(decorLane && decorLane.ownerId == null,
      "assemble drops a disabled client-chosen lane owner to null");

    // ── 7. Orphan surfacing: disabled owner's open lead is flagged ───────────
    // Mirror DashboardService's inactive-owner query (status!=active OR isDisabled).
    const orphanOwners = (await Admin.find(
      { $or: [{ status: { $ne: "active" } }, { isDisabled: true }] }, { _id: 1 }
    ).lean()).map((a) => a._id);
    ok(has(orphanOwners, disabled._id),
      "dashboard orphan-owner query now catches the disabled (status:active) owner");

    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    // Restore settings.
    await SettingsService.set("assignment.poolRoles", savedPoolRoles);
    await SettingsService.set("assignment.overflowRoles", savedOverflow);
    await SettingsService.set("assignment.autoAssignEnabled", savedAuto);
    await SettingsService.set("assignment.mode", savedMode);
    // Clean up seeded docs.
    await LaneEntry.deleteMany({ laneId: { $in: created.lanes } }).catch(() => {});
    await LeadLane.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
    await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
    if (role) await Role.deleteOne({ _id: role._id }).catch(() => {});
    if (dept) await Department.deleteOne({ _id: dept._id }).catch(() => {});
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
