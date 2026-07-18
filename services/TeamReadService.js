// W6 — TEAM READ. The manager+ team page: member rows with work rollups plus
// the pending-disqualification approvals queue.
//   members — direct reports for managers; the department for a Revenue Head;
//             everyone for a founder.
//   rollups — MIRROR the dashboard's teamRollup semantics exactly (the M2
//             bridge): cadence counts are LEAD-level ($elemMatch), the journey
//             store is attributed by Followup.ownerId and narrowed to ACTIVE +
//             visible leads; open/parked mirror OffboardService.openLeadCounts.
//   pendingApprovals — the EXACT existing eligibility helpers from
//             controllers/disqualify.js (approve permission OR manager-of-
//             assignee), same item shape as GET /enquiry/pending-disqualifications.
const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Followup = require("../models/Followup");
const EnquiryRepository = require("../repositories/EnquiryRepository");
const { currentVisibilityFilter } = require("../utils/leadVisibility");
const { istDayStart, istDayEnd } = require("../utils/goldenWindow");

const err = (status, message) => Object.assign(new Error(message), { status });

// Same predicates the machinery being mirrored uses (DashboardService.ACTIVE /
// OffboardService.OPEN_STAGE) — kept verbatim so numbers can never diverge.
const { notLostFilter } = require("../utils/lostTerminal");
const ACTIVE = {
  ...notLostFilter(),
  stage: { $nin: ["won", "lost"] },
  "recycled.isRecycled": { $ne: true },
};
const OPEN_STAGE = { ...notLostFilter(), stage: { $nin: ["won", "lost"] } };

const MEMBER_PROJ = { name: 1, status: 1, isDisabled: 1, roleId: 1, roleIds: 1, hats: 1, departmentId: 1 };

const team = async (callerId) => {
  const now = new Date();
  const todayStart = istDayStart(now);
  const todayEnd = istDayEnd(now);

  const { callerContext } = require("./RoleService");
  const { roleIdsOf } = require("../middlewares/requirePermission");
  const { admin, isFounder } = await callerContext(callerId);
  if (!admin) throw err(404, "Admin not found");
  const callerRoles = roleIdsOf(admin).length
    ? await Role.find({ _id: { $in: roleIdsOf(admin) }, deletedAt: null }, { name: 1 }).lean()
    : [];
  const isRevenueHead = callerRoles.some((r) => r.name === "Revenue Head");

  // Member set — disabled members stay visible (their parked leads matter);
  // the row's isDisabled flag carries the state.
  let members;
  if (isFounder) {
    members = await Admin.find({}, MEMBER_PROJ).sort({ name: 1 }).lean();
  } else if (isRevenueHead && admin.departmentId) {
    members = await Admin.find({ departmentId: admin.departmentId }, MEMBER_PROJ).sort({ name: 1 }).lean();
  } else {
    members = await Admin.find({ reportingManagerId: callerId }, MEMBER_PROJ).sort({ name: 1 }).lean();
  }
  const memberIds = members.map((m) => m._id);

  // Primary role names in one batch.
  const primaryRoleId = (m) =>
    m.roleId || (m.roleIds && m.roleIds[0]) || (m.hats && m.hats[0] && m.hats[0].roleId) || null;
  const roleIds = [...new Set(members.map(primaryRoleId).filter(Boolean).map(String))];
  const roleDocs = roleIds.length ? await Role.find({ _id: { $in: roleIds } }, { name: 1 }).lean() : [];
  const roleName = new Map(roleDocs.map((r) => [String(r._id), r.name]));

  const visibility = await currentVisibilityFilter();

  const [openParked, cadenceDue, cadenceOverdue, journeyRows] = memberIds.length
    ? await Promise.all([
        // open/parked — OffboardService.openLeadCounts semantics, batched.
        Enquiry.aggregate([
          { $match: { assignedTo: { $in: memberIds }, ...OPEN_STAGE } },
          {
            $group: {
              _id: "$assignedTo",
              total: { $sum: 1 },
              parked: { $sum: { $cond: [{ $ne: [{ $ifNull: ["$snoozedUntil", null] }, null] }, 1, 0] } },
            },
          },
        ]),
        // cadence dueToday — LEAD-level ($elemMatch), like the dashboard rollup.
        Enquiry.aggregate([
          {
            $match: {
              $and: [
                { assignedTo: { $in: memberIds }, ...ACTIVE, followUps: { $elemMatch: { completedAt: null, scheduledAt: { $gte: todayStart, $lte: todayEnd } } } },
                visibility,
              ],
            },
          },
          { $group: { _id: "$assignedTo", n: { $sum: 1 } } },
        ]),
        // cadence overdue.
        Enquiry.aggregate([
          {
            $match: {
              $and: [
                { assignedTo: { $in: memberIds }, ...ACTIVE, followUps: { $elemMatch: { completedAt: null, scheduledAt: { $lt: todayStart } } } },
                visibility,
              ],
            },
          },
          { $group: { _id: "$assignedTo", n: { $sum: 1 } } },
        ]),
        // journey store — DashboardService.journeyDueByOwner, verbatim semantics.
        Followup.find(
          {
            ownerId: { $in: memberIds },
            dueAt: { $lte: todayEnd },
            $or: [{ status: "open" }, { status: "snoozed", snoozedUntil: { $lte: now } }],
          },
          { ownerId: 1, dueAt: 1, leadId: 1 }
        ).lean(),
      ])
    : [[], [], [], []];

  // Journey rows only count when their lead is still ACTIVE + visible.
  const jLeadIds = [...new Set(journeyRows.map((r) => String(r.leadId)))];
  const jLiveLeads = jLeadIds.length
    ? await Enquiry.find({ $and: [{ _id: { $in: jLeadIds } }, ACTIVE, visibility] }, { _id: 1 }).lean()
    : [];
  const jLeadSet = new Set(jLiveLeads.map((l) => String(l._id)));
  const journeyByOwner = new Map();
  for (const r of journeyRows) {
    if (!r.ownerId || !jLeadSet.has(String(r.leadId))) continue;
    const key = String(r.ownerId);
    if (!journeyByOwner.has(key)) journeyByOwner.set(key, { dueToday: 0, overdue: 0 });
    if (new Date(r.dueAt) < todayStart) journeyByOwner.get(key).overdue += 1;
    else journeyByOwner.get(key).dueToday += 1;
  }

  const byId = (rows) => new Map(rows.map((r) => [String(r._id), r]));
  const opMap = byId(openParked);
  const cdMap = byId(cadenceDue);
  const coMap = byId(cadenceOverdue);

  const memberRows = members.map((m) => {
    const id = String(m._id);
    const op = opMap.get(id) || { total: 0, parked: 0 };
    const jd = journeyByOwner.get(id) || { dueToday: 0, overdue: 0 };
    const rid = primaryRoleId(m);
    return {
      adminId: id,
      name: m.name,
      role: rid ? roleName.get(String(rid)) || null : null,
      status: m.status,
      isDisabled: !!m.isDisabled,
      openLeads: op.total,
      dueToday: (cdMap.get(id)?.n || 0) + jd.dueToday,
      overdue: (coMap.get(id)?.n || 0) + jd.overdue,
      parked: op.parked,
    };
  });

  // Pending approvals — the exact existing eligibility helpers, same shape as
  // GET /enquiry/pending-disqualifications.
  const { actorHasApprovePermission, isManagerOfAssigned } = require("../controllers/disqualify");
  const canApproveAll = await actorHasApprovePermission(callerId);
  const pending = await EnquiryRepository.findPendingDisqualifications();
  const pendingApprovals = [];
  for (const lead of pending) {
    const ownerId = lead.assignedTo?._id || lead.assignedTo;
    const eligible = canApproveAll || (await isManagerOfAssigned(callerId, ownerId));
    if (!eligible) continue;
    pendingApprovals.push({
      lead: {
        _id: lead._id,
        name: lead.name,
        phone: lead.phone,
        email: lead.email,
        stage: lead.stage,
        assignedTo: lead.assignedTo || null,
      },
      requester: lead.lostRequestedBy || null,
      reason: lead.lostReason || "",
      note: lead.lostNote || "",
      requestedAt: lead.lostRequestedAt || null,
    });
  }

  return {
    members: memberRows,
    pendingApprovals: { items: pendingApprovals, total: pendingApprovals.length },
    scope: isFounder ? "all" : isRevenueHead ? "department" : "team",
    generatedAt: now,
  };
};

module.exports = { team };
