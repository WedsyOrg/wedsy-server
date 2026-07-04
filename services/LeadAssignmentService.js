const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Enquiry = require("../models/Enquiry");
const LeadInternalEventService = require("./LeadInternalEventService");
const { istDayStart } = require("../utils/goldenWindow");

const SettingsService = require("./SettingsService");

// Defaults live in SettingsService (assignment.*) — these constants remain only
// as exported legacy names; runtime reads the settings (which default to these).
const DAILY_ASSIGNMENT_CAP = 15;
const POOL_ROLE_NAMES = ["Sales Intern", "Sales Executive"];

// Least-recently-assigned ACTIVE admin in the pools with remaining daily capacity.
// Round-robin state is the additive Admin.lastAssignedAt field (nulls sort first,
// so brand-new pool members get the next lead).
const pickAssignee = async () => {
  const todayStart = istDayStart();
  const cfg = await SettingsService.getMany([
    "assignment.poolRoles",
    "assignment.overflowRoles",
    "assignment.dailyCap",
  ]);
  const poolRoleNames = [...cfg["assignment.poolRoles"], ...cfg["assignment.overflowRoles"]];
  const dailyCap = cfg["assignment.dailyCap"];
  for (const roleName of poolRoleNames) {
    const role = await Role.findOne({ name: roleName, deletedAt: null }).lean();
    if (!role) continue;
    const pool = await Admin.find({ roleId: role._id, status: "active" })
      .sort({ lastAssignedAt: 1 })
      .lean();
    for (const admin of pool) {
      const assignedToday = await Enquiry.countDocuments({
        assignedTo: admin._id,
        createdAt: { $gte: todayStart },
      });
      if (assignedToday < dailyCap) return admin;
    }
  }
  return null;
};

// Auto-assign a freshly-created lead. Nobody available → lead stays unassigned and
// an "assignment_failed" event makes it scream on the founder dashboard's untouched list.
// Never throws (intake must not fail because assignment did).
const doAssignLead = async (enquiryId) => {
  try {
    if (!(await SettingsService.get("assignment.autoAssignEnabled"))) {
      return null; // auto-assignment switched off in Settings — lead stays unassigned
    }
    // MB5 Slice 4: triage mode — the lead lands UNASSIGNED in the triage queue
    // instead of round-robin. 'auto' (the shipped default) is byte-identical
    // to the old behavior.
    if ((await SettingsService.get("assignment.mode")) === "triage") {
      await Enquiry.findByIdAndUpdate(enquiryId, {
        $set: { triagePending: true, triageEnteredAt: new Date() },
      });
      await LeadInternalEventService.record({
        leadId: enquiryId,
        type: "triage_entered",
        actorId: null,
        payload: {},
      });
      return null;
    }
    const assignee = await pickAssignee();
    if (!assignee) {
      await LeadInternalEventService.record({
        leadId: enquiryId,
        type: "assignment_failed",
        actorId: null,
        payload: { reason: "No active pool member under the daily cap" },
      });
      return null;
    }
    await Enquiry.findByIdAndUpdate(enquiryId, { $set: { assignedTo: assignee._id } });
    await Admin.findByIdAndUpdate(assignee._id, { $set: { lastAssignedAt: new Date() } });
    await LeadInternalEventService.record({
      leadId: enquiryId,
      type: "auto_assigned",
      actorId: null,
      payload: { assignedTo: String(assignee._id), assignedToName: assignee.name },
    });
    return assignee;
  } catch (e) {
    console.error("LeadAssignmentService.assignLead failed:", e.message);
    return null;
  }
};

// Serialize assignments in-process: burst arrivals (webhook spikes) would otherwise
// race the least-recently-assigned read before lastAssignedAt persists and skew the
// round-robin. Single node process today; a multi-instance deploy would need an
// atomic DB claim instead (noted in the lifecycle report).
let assignmentQueue = Promise.resolve();
const assignLead = (enquiryId) => {
  const task = assignmentQueue.then(() => doAssignLead(enquiryId));
  assignmentQueue = task.catch(() => {});
  return task;
};

module.exports = { assignLead, pickAssignee, DAILY_ASSIGNMENT_CAP, POOL_ROLE_NAMES };
