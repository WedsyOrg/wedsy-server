const mongoose = require("mongoose");
const ProjectRepository = require("../repositories/ProjectRepository");
const EnquiryRepository = require("../repositories/EnquiryRepository");
const EnquiryService = require("./EnquiryService");
const LeadInternalEventService = require("./LeadInternalEventService");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const User = require("../models/User");
const Event = require("../models/Event");

const CS_ROLE_NAME = "Client Servicing Executive";

const httpError = (status, message) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

// Default CS owner: the (first) active Client Servicing Executive.
const defaultCsOwner = async () => {
  const role = await Role.findOne({ name: CS_ROLE_NAME, deletedAt: null }).lean();
  if (!role) return null;
  return await Admin.findOne({ roleId: role._id, status: "active" }).lean();
};

// Convert a Meeting-Scheduled lead into a Project (Slice D). The lead moves to the
// "won" terminal stage and leaves every active dashboard/list view.
const convertLead = async (enquiryId, { csOwnerId, value, handoffNote } = {}, actorId) => {
  if (!mongoose.Types.ObjectId.isValid(enquiryId)) {
    throw httpError(400, "Invalid enquiry id");
  }
  const lead = await EnquiryRepository.findById(enquiryId);
  if (!lead) throw httpError(404, "Enquiry not found");
  if (lead.stage !== "meeting_scheduled") {
    throw httpError(422, "Only a Meeting-Scheduled lead can move to Projects — advance the stage first");
  }
  if (lead.lostStatus === "pending") {
    throw httpError(422, "A disqualification decision is pending on this lead");
  }
  const existing = await ProjectRepository.findByLeadId(enquiryId);
  if (existing) throw httpError(400, "This lead is already converted to a project");

  let csOwner = null;
  if (csOwnerId) {
    if (!mongoose.Types.ObjectId.isValid(csOwnerId)) {
      throw httpError(400, "Invalid csOwnerId");
    }
    csOwner = await Admin.findById(csOwnerId).lean();
    if (!csOwner) throw httpError(400, "csOwnerId does not match any admin");
  } else {
    csOwner = await defaultCsOwner();
  }

  // Events created for this lead's linked user (when one exists).
  const user = await User.findOne({ phone: lead.phone }).lean();
  const events = user ? await Event.find({ user: user._id }, { _id: 1 }).lean() : [];

  const q = lead.qualificationData || {};
  const coupleNames =
    q.groomName && q.brideName ? `${q.groomName} x ${q.brideName}` : lead.name;

  const project = await ProjectRepository.create({
    leadId: lead._id,
    coupleNames,
    eventIds: events.map((e) => e._id),
    csOwnerId: csOwner ? csOwner._id : null,
    convertedBy: actorId || null,
    value: Number(value) || 0,
    handoffNote: handoffNote || "",
  });

  // Terminal stage move through the existing pipeline (Won stage is seeded by
  // scripts/lifecycle-role-patch.js — see deploy checklist).
  await EnquiryService.updateStage(enquiryId, "won", actorId);

  await LeadInternalEventService.record({
    leadId: enquiryId,
    type: "converted_to_project",
    actorId,
    payload: {
      projectId: String(project._id),
      csOwnerId: csOwner ? String(csOwner._id) : null,
      value: Number(value) || 0,
    },
  });

  return project;
};

// Scope-filtered project list with display names joined in.
const listProjects = async (scopeFilter = {}) => {
  const projects = await ProjectRepository.findAll(scopeFilter);
  const adminIds = [
    ...new Set(
      projects.flatMap((p) => [p.csOwnerId, p.convertedBy].filter(Boolean).map(String))
    ),
  ];
  const leadIds = projects.map((p) => p.leadId).filter(Boolean);
  const [admins, leads] = await Promise.all([
    adminIds.length ? Admin.find({ _id: { $in: adminIds } }, { name: 1 }).lean() : [],
    leadIds.length
      ? require("../models/Enquiry").find({ _id: { $in: leadIds } }, { name: 1, phone: 1, stage: 1 }).lean()
      : [],
  ]);
  const adminName = new Map(admins.map((a) => [String(a._id), a.name]));
  const leadById = new Map(leads.map((l) => [String(l._id), l]));
  return projects.map((p) => ({
    ...p,
    csOwnerName: adminName.get(String(p.csOwnerId)) || "—",
    convertedByName: adminName.get(String(p.convertedBy)) || "—",
    lead: leadById.get(String(p.leadId)) || null,
  }));
};

module.exports = { convertLead, listProjects, defaultCsOwner, CS_ROLE_NAME };
