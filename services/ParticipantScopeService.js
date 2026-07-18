// C1 — "LEADS I'M ON" (participant scope, shared by the CS + Venues
// workspaces). One id-set aggregation: an admin PARTICIPATES on a lead when
// they are the owner (assignedTo) OR on the qualify-continuity roster
// (LeadTeamMember, activeTo null) OR own any LeadLane OR are assignee of any
// OPEN lead-task. Any authed admin may use the scope for THEMSELVES; managers
// may pass ?adminId= for a report inside their permission scope.
const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const LeadTeamMember = require("../models/LeadTeamMember");
const LeadLane = require("../models/LeadLane");
const LeadTask = require("../models/LeadTask");

const err = (status, message) => Object.assign(new Error(message), { status });
const oid = (v) => new mongoose.Types.ObjectId(String(v));

// ONE aggregation (three $unionWith legs) → deduped lead-id set.
const participantLeadIds = async (adminId) => {
  const id = oid(adminId);
  const rows = await LeadTeamMember.aggregate([
    { $match: { personId: id, activeTo: null } },
    { $project: { _id: 0, leadId: 1 } },
    {
      $unionWith: {
        coll: LeadLane.collection.name,
        pipeline: [{ $match: { ownerId: id } }, { $project: { _id: 0, leadId: 1 } }],
      },
    },
    {
      $unionWith: {
        coll: LeadTask.collection.name,
        pipeline: [{ $match: { assigneeId: id, status: "open" } }, { $project: { _id: 0, leadId: 1 } }],
      },
    },
    {
      $unionWith: {
        coll: Enquiry.collection.name,
        pipeline: [{ $match: { assignedTo: id } }, { $project: { _id: 0, leadId: "$_id" } }],
      },
    },
    { $group: { _id: "$leadId" } },
  ]);
  return rows.map((r) => r._id).filter(Boolean);
};

// The mongo filter the existing pipelines AND in.
const participantFilter = async (adminId) => ({ _id: { $in: await participantLeadIds(adminId) } });

// ?adminId= resolution: self always; someone else only inside the caller's
// requirePermission scope (team → subordinate closure; department → members;
// all → anyone).
const resolveParticipantTarget = async (req) => {
  const callerId = req.auth.user_id;
  const requested = req.query.adminId;
  if (!requested || String(requested) === String(callerId)) return callerId;
  if (!mongoose.Types.ObjectId.isValid(String(requested))) throw err(400, "Invalid adminId");
  const scope = req.scope || "own";
  if (scope === "all") return requested;
  const { getSubordinateIds, getDepartmentMemberIds } = require("../middlewares/requirePermission");
  if (scope === "team") {
    const subs = (await getSubordinateIds(callerId)).map(String);
    if (subs.includes(String(requested))) return requested;
  } else if (scope === "department") {
    const admin = req.auth.user;
    const members = (await getDepartmentMemberIds(admin && admin.departmentId)).map(String);
    if (members.includes(String(requested))) return requested;
  }
  throw err(403, "That teammate is not in your scope.");
};

module.exports = { participantLeadIds, participantFilter, resolveParticipantTarget };
