const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Attendance = require("../models/Attendance");
const WAConversation = require("../models/WAConversation");
const WAAgentMessage = require("../models/WAAgentMessage");
const SettingsService = require("./SettingsService");
const AttendanceService = require("./AttendanceService");
const LeadInternalEventService = require("./LeadInternalEventService");
const AdminNotificationService = require("./AdminNotificationService");
const { permissionSatisfies } = require("../middlewares/requirePermission");
const { goldenWindowFor, toIstWallClock } = require("../utils/goldenWindow");
const { assignableFilter } = require("../utils/assignable");

const httpError = (status, message) => Object.assign(new Error(message), { status });

// ── Who holds triage? Admins whose ROLE grants leads:triage (any scope). ──────
const HOLDER_CACHE_TTL_MS = 60 * 1000;
let holderCache = { ids: null, expires: 0 };

const triageHolderIds = async () => {
  if (holderCache.ids && holderCache.expires > Date.now()) return holderCache.ids;
  const roles = await Role.find({ deletedAt: null }, { permissions: 1 }).lean();
  const holderRoleIds = roles
    .filter((r) => permissionSatisfies(r.permissions || [], "leads:triage:own").allowed)
    .map((r) => r._id);
  const holders = holderRoleIds.length
    // RBAC v2: match the role on roleId OR any of roleIds[] (multi-role).
    ? await Admin.find(assignableFilter({ $or: [{ roleId: { $in: holderRoleIds } }, { roleIds: { $in: holderRoleIds } }] }), { _id: 1 }).lean()
    : [];
  const ids = holders.map((h) => h._id);
  holderCache = { ids, expires: Date.now() + HOLDER_CACHE_TTL_MS };
  return ids;
};

// ── Pool interns with live status (the assign picker + auto-assign target). ───
const internsWithStatus = async () => {
  const poolRoles = (await SettingsService.get("assignment.poolRoles")) || [];
  const roles = await Role.find({ name: { $in: poolRoles }, deletedAt: null }, { _id: 1 }).lean();
  const roleIds = roles.map((r) => r._id);
  const interns = await Admin.find(
    assignableFilter({ $or: [{ roleId: { $in: roleIds } }, { roleIds: { $in: roleIds } }] }),
    { name: 1, reportingManagerId: 1, lastAssignedAt: 1 }
  ).lean();
  const CalendarEventService = require("./CalendarEventService");
  const [liveIds, attRows] = await Promise.all([
    CalendarEventService.liveMeetingAdminIds(),
    Attendance.find({ adminId: { $in: interns.map((i) => i._id) }, date: AttendanceService.dayKey() }).lean(),
  ]);
  const attByAdmin = new Map(attRows.map((r) => [String(r.adminId), r]));
  const now = new Date();
  return interns.map((i) => ({
    _id: i._id,
    name: i.name,
    reportingManagerId: i.reportingManagerId || null,
    lastAssignedAt: i.lastAssignedAt || null,
    status: AttendanceService.statusOf(attByAdmin.get(String(i._id)) || null, now, liveIds),
  }));
};

// ── The triage queue (dashboard section + leads filter both read this). ──────
const TRANSCRIPT_PREVIEW_MESSAGES = 3;

const listTriage = async () => {
  // Lazy escalation sweep rides every queue read (the established no-new-infra pattern).
  await sweepEscalations().catch(() => {});

  const goldenCfg = await SettingsService.getMany([
    "golden.windowMinutes",
    "golden.workStartHour",
    "golden.workEndHour",
  ]);
  const cfg = {
    windowMinutes: goldenCfg["golden.windowMinutes"],
    workStartHour: goldenCfg["golden.workStartHour"],
    workEndHour: goldenCfg["golden.workEndHour"],
  };
  const leads = await Enquiry.find({
    triagePending: true,
    assignedTo: null,
    "recycled.isRecycled": { $ne: true },
    stage: { $nin: ["won", "lost"] },
  })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  // Kiara transcript preview for any lead with a conversation — whatsapp
  // intake AND safety-net-engaged leads (the morning pile, Slice 5).
  const convs = leads.length
    ? await WAConversation.find({ enquiryId: { $in: leads.map((l) => l._id) } }).lean()
    : [];
  const convByLead = new Map(convs.map((c) => [String(c.enquiryId), c]));
  const transcripts = new Map();
  for (const c of convs) {
    const msgs = await WAAgentMessage.find({ phone: c.phone }, { role: 1, message: 1, createdAt: 1 })
      .sort({ createdAt: -1 })
      .limit(TRANSCRIPT_PREVIEW_MESSAGES)
      .lean();
    transcripts.set(String(c.enquiryId), msgs.reverse());
  }

  const now = new Date();
  return leads.map((l) => ({
    _id: l._id,
    name: l.name,
    source: l.source,
    createdAt: l.createdAt,
    triageEnteredAt: l.triageEnteredAt,
    triageEscalatedAt: l.triageEscalatedAt,
    goldenWindow: goldenWindowFor(l.createdAt, now, cfg),
    conversationId: convByLead.has(String(l._id)) ? convByLead.get(String(l._id))._id : null,
    transcript: transcripts.get(String(l._id)) || [],
  }));
};

// ── Assign out of triage (picker or "take it myself"). ───────────────────────
const assign = async (leadId, toAdminId, actorId) => {
  if (!mongoose.Types.ObjectId.isValid(leadId)) throw httpError(400, "Invalid lead id");
  if (!mongoose.Types.ObjectId.isValid(toAdminId)) throw httpError(400, "Invalid admin id");
  const target = await Admin.findOne({ _id: toAdminId, status: "active" }, { name: 1 }).lean();
  if (!target) throw httpError(404, "Assignee not found or inactive");
  const lead = await Enquiry.findOneAndUpdate(
    { _id: leadId, triagePending: true },
    { $set: { assignedTo: target._id, triagePending: false } },
    { new: true }
  );
  if (!lead) throw httpError(404, "Lead is not in triage");
  await Admin.findByIdAndUpdate(target._id, { $set: { lastAssignedAt: new Date() } });
  await LeadInternalEventService.record({
    leadId,
    type: "triage_assigned",
    actorId,
    payload: {
      to: String(target._id),
      toName: target.name,
      self: String(target._id) === String(actorId),
    },
  });
  if (String(target._id) !== String(actorId)) {
    await AdminNotificationService.notify(target._id, {
      type: "triage_assigned",
      title: `${lead.name} assigned to you from triage`,
      message: "Fresh lead — call within the golden window.",
      leadId,
    });
  }
  return lead;
};

// ── Escalation chain (lazy/poll — invoked from queue + dashboard reads). ─────
// After triage.escalateAfterMinutes unassigned (working hours only):
//   → notify ALL triage holders (once per lead).
//   → if ALL holders are in_meeting at that moment: auto-assign to a
//     checked-in ONLINE intern + notify Revenue Head + that intern's sales
//     lead with reason "auto-assigned: triage was in meetings".
const inWorkingHours = async (now = new Date()) => {
  const cfg = await SettingsService.getMany(["golden.workStartHour", "golden.workEndHour"]);
  const istHour = toIstWallClock(now).getUTCHours();
  return istHour >= cfg["golden.workStartHour"] && istHour < cfg["golden.workEndHour"];
};

const revenueHeadIds = async () => {
  const role = await Role.findOne({ name: "Revenue Head", deletedAt: null }, { _id: 1 }).lean();
  if (!role) return [];
  const heads = await Admin.find(assignableFilter({ $or: [{ roleId: role._id }, { roleIds: role._id }] }), { _id: 1 }).lean();
  return heads.map((h) => h._id);
};

const sweepEscalations = async (now = new Date()) => {
  if ((await SettingsService.get("assignment.mode")) !== "triage") return { escalated: 0 };
  if (!(await inWorkingHours(now))) return { escalated: 0 };

  const afterMinutes = await SettingsService.get("triage.escalateAfterMinutes");
  const cutoff = new Date(now.getTime() - afterMinutes * 60 * 1000);
  const due = await Enquiry.find({
    triagePending: true,
    assignedTo: null,
    triageEscalatedAt: null,
    triageEnteredAt: { $lte: cutoff },
  })
    .limit(20)
    .lean();
  if (!due.length) return { escalated: 0 };

  const holders = await triageHolderIds();
  const CalendarEventService = require("./CalendarEventService");
  const liveIds = await CalendarEventService.liveMeetingAdminIds(now);
  // "ALL triage holders in_meeting" counts only holders who are CHECKED IN —
  // a checked-out holder can't act on triage either way. Nobody checked in at
  // all → same outcome: the queue has no available human, auto-assign.
  const attRows = await Attendance.find({
    adminId: { $in: holders },
    date: AttendanceService.dayKey(now),
  }).lean();
  const checkedInHolders = attRows
    .filter((r) => r.checkInAt && !r.checkOutAt)
    .map((r) => String(r.adminId));
  const allHoldersInMeeting =
    holders.length > 0 &&
    (checkedInHolders.length === 0 || checkedInHolders.every((h) => liveIds.has(h)));

  let escalated = 0;
  for (const lead of due) {
    // CAS guard — one concurrent sweep wins.
    const claimed = await Enquiry.findOneAndUpdate(
      { _id: lead._id, triageEscalatedAt: null, triagePending: true },
      { $set: { triageEscalatedAt: now } },
      { new: true }
    );
    if (!claimed) continue;
    escalated++;

    await LeadInternalEventService.record({
      leadId: lead._id,
      type: "triage_escalated",
      actorId: null,
      payload: { afterMinutes, allHoldersInMeeting },
    });
    await AdminNotificationService.notify(holders, {
      type: "triage_escalation",
      title: `Triage waiting ${afterMinutes}+ min: ${lead.name}`,
      message: "Unassigned new lead is aging — assign or take it.",
      leadId: lead._id,
    });

    if (allHoldersInMeeting) {
      // Pick a checked-in ONLINE intern (least recently assigned first).
      const interns = (await internsWithStatus())
        .filter((i) => i.status === "online")
        .sort((a, b) => new Date(a.lastAssignedAt || 0) - new Date(b.lastAssignedAt || 0));
      const target = interns[0];
      if (!target) continue; // nobody online — holders were notified, queue stays
      await Enquiry.findByIdAndUpdate(lead._id, {
        $set: { assignedTo: target._id, triagePending: false },
      });
      await Admin.findByIdAndUpdate(target._id, { $set: { lastAssignedAt: new Date() } });
      await LeadInternalEventService.record({
        leadId: lead._id,
        type: "triage_auto_assigned",
        actorId: null,
        payload: {
          to: String(target._id),
          toName: target.name,
          reason: "auto-assigned: triage was in meetings",
        },
      });
      await AdminNotificationService.notify(target._id, {
        type: "triage_auto_assigned",
        title: `${lead.name} auto-assigned to you`,
        message: "Triage was in meetings — call them now (golden window).",
        leadId: lead._id,
      });
      await AdminNotificationService.notify(await revenueHeadIds(), {
        type: "triage_auto_assigned",
        title: `Triage overflow: ${lead.name} auto-assigned to ${target.name}`,
        message: "auto-assigned: triage was in meetings",
        leadId: lead._id,
      });
      if (target.reportingManagerId) {
        await AdminNotificationService.notify(target.reportingManagerId, {
          type: "triage_auto_assigned",
          title: `${lead.name} auto-assigned to ${target.name} (your team)`,
          message: "auto-assigned: triage was in meetings",
          leadId: lead._id,
        });
      }
    }
  }
  return { escalated };
};

module.exports = {
  listTriage,
  assign,
  internsWithStatus,
  triageHolderIds,
  sweepEscalations,
  inWorkingHours,
  revenueHeadIds,
  _holderCache: holderCache,
};
