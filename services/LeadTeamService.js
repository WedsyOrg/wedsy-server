const mongoose = require("mongoose");
const Admin = require("../models/Admin");
const Department = require("../models/Department");
const Role = require("../models/Role");
const LeadTeamMemberRepository = require("../repositories/LeadTeamMemberRepository");
const LeadInternalEventService = require("./LeadInternalEventService");
const AdminNotificationService = require("./AdminNotificationService");
const { roleIdsOf } = require("../middlewares/requirePermission");

const err = (status, message) => Object.assign(new Error(message), { status });

// An admin's departments = their direct departmentId UNION the department of
// every role they hold (roles are department-scoped — RBAC v2 multi-role). This
// is how multi-department is real per HRMS: a person under two roles in two
// departments belongs to both.
const departmentsOfAdmin = (admin, roleById) => {
  const ids = new Set();
  if (admin.departmentId) ids.add(String(admin.departmentId));
  for (const rid of roleIdsOf(admin)) {
    const role = roleById.get(String(rid));
    if (role && role.departmentId) ids.add(String(role.departmentId));
  }
  return ids;
};

// People grouped by department for the Assign-Team dropdown. An admin in
// multiple departments appears under EACH (no de-dup across groups) — multi-
// department is intentional. Source: RBAC Departments + active admins.
const peopleOptions = async () => {
  const [departments, admins] = await Promise.all([
    Department.find({ deletedAt: null }, { name: 1 }).sort({ name: 1 }).lean(),
    Admin.find({ status: "active" }, { name: 1, departmentId: 1, roleId: 1, roleIds: 1, "meta.designation": 1 })
      .sort({ name: 1 })
      .lean(),
  ]);

  const roleIds = new Set();
  for (const a of admins) for (const rid of roleIdsOf(a)) roleIds.add(String(rid));
  const roles = roleIds.size
    ? await Role.find({ _id: { $in: [...roleIds] } }, { departmentId: 1 }).lean()
    : [];
  const roleById = new Map(roles.map((r) => [String(r._id), r]));

  const groups = departments.map((d) => ({
    departmentId: String(d._id),
    departmentName: d.name,
    people: [],
  }));
  const groupByDept = new Map(groups.map((g) => [g.departmentId, g]));
  const noDept = { departmentId: null, departmentName: "No department", people: [] };

  for (const a of admins) {
    const depIds = departmentsOfAdmin(a, roleById);
    const person = { _id: String(a._id), name: a.name, designation: a.meta?.designation || "" };
    if (depIds.size === 0) {
      noDept.people.push(person);
      continue;
    }
    for (const did of depIds) {
      const g = groupByDept.get(did);
      if (g) g.people.push(person);
    }
  }

  const out = groups.filter((g) => g.people.length);
  if (noDept.people.length) out.push(noDept);
  return { groups: out };
};

// Resolve admin + department names for a set of roster rows.
const decorate = async (rows) => {
  const adminIds = new Set();
  for (const r of rows) {
    if (r.personId) adminIds.add(String(r.personId));
    if (r.addedBy) adminIds.add(String(r.addedBy));
    if (r.removedBy) adminIds.add(String(r.removedBy));
  }
  const admins = adminIds.size
    ? await Admin.find({ _id: { $in: [...adminIds] } }, { name: 1 }).lean()
    : [];
  const nameOf = new Map(admins.map((a) => [String(a._id), a.name]));
  const name = (id) => (id ? nameOf.get(String(id)) || "—" : null);
  return rows.map((r) => ({
    _id: String(r._id),
    personId: String(r.personId),
    personName: name(r.personId),
    departmentId: r.departmentId ? String(r.departmentId) : null,
    departmentName: r.departmentName || "",
    role: r.role || "",
    addedBy: r.addedBy ? String(r.addedBy) : null,
    addedByName: name(r.addedBy),
    addedAt: r.addedAt,
    activeFrom: r.activeFrom,
    activeTo: r.activeTo || null,
    removedBy: r.removedBy ? String(r.removedBy) : null,
    removedByName: name(r.removedBy),
    active: !r.activeTo,
  }));
};

// Current team + full history for a lead.
const listRoster = async (leadId) => {
  if (!mongoose.Types.ObjectId.isValid(leadId)) throw err(400, "Invalid lead id");
  const [currentRows, historyRows] = await Promise.all([
    LeadTeamMemberRepository.findCurrentByLead(leadId),
    LeadTeamMemberRepository.findByLead(leadId),
  ]);
  return {
    current: await decorate(currentRows),
    history: await decorate(historyRows),
  };
};

// Add a member to the roster. Writes an append-only row, a named journey event,
// and notifies the new member (full-context: they get the WHOLE lead, Slice 4).
const addMember = async (leadId, { personId, departmentId, role }, actorId) => {
  if (!mongoose.Types.ObjectId.isValid(leadId)) throw err(400, "Invalid lead id");
  if (!personId || !mongoose.Types.ObjectId.isValid(String(personId)))
    throw err(400, "personId is required");
  if (role !== undefined && !["", "qualifier"].includes(role))
    throw err(400, 'role must be "" or "qualifier"');

  const person = await Admin.findById(personId, { name: 1, departmentId: 1, roleId: 1, roleIds: 1 }).lean();
  if (!person) throw err(404, "Person not found");

  // Resolve which department this person is serving. If they belong to exactly
  // one, it's implied; otherwise the caller must pick one of theirs.
  let depId = departmentId && mongoose.Types.ObjectId.isValid(String(departmentId)) ? String(departmentId) : null;
  const roleIds = roleIdsOf(person);
  const roles = roleIds.length
    ? await Role.find({ _id: { $in: roleIds } }, { departmentId: 1 }).lean()
    : [];
  const roleById = new Map(roles.map((r) => [String(r._id), r]));
  const personDepts = departmentsOfAdmin(person, roleById);

  if (depId) {
    if (personDepts.size && !personDepts.has(depId))
      throw err(400, "That person does not belong to the chosen department");
  } else if (personDepts.size === 1) {
    depId = [...personDepts][0];
  } else if (personDepts.size > 1) {
    throw err(400, "This person is in multiple departments — choose which one they serve");
  }

  let departmentName = "";
  if (depId) {
    const dept = await Department.findById(depId, { name: 1 }).lean();
    if (!dept) throw err(404, "Department not found");
    departmentName = dept.name;
  }

  // Append-only dup guard: same person + same department, still active.
  const existing = await LeadTeamMemberRepository.findActiveMembership(leadId, personId, depId);
  if (existing) throw err(409, "Already on this lead's team for that department");

  const row = await LeadTeamMemberRepository.create({
    leadId,
    personId,
    departmentId: depId,
    departmentName,
    role: role || "",
    addedBy: actorId || null,
    addedAt: new Date(),
    activeFrom: new Date(),
    activeTo: null,
  });

  // Journey event (actor-named title built in JourneyService.dynamicTitle).
  await LeadInternalEventService.record({
    leadId,
    type: "team_member_added",
    actorId,
    payload: { personId: String(personId), personName: person.name, departmentId: depId, departmentName },
  });

  // Full-context transfer (Slice 4): the new member is notified and the lead
  // surfaces on their dashboard — they see the ENTIRE history, never truncated.
  await AdminNotificationService.notify(personId, {
    type: "team_added",
    title: "You've been added to a lead's team",
    message: departmentName ? `You're on this lead as ${departmentName}.` : "You're on this lead's team.",
    leadId,
    payload: { departmentId: depId, departmentName, addedBy: actorId ? String(actorId) : null },
  });

  return (await decorate([row]))[0];
};

// Remove a member: close the active row (activeTo + removedBy). History retained.
const removeMember = async (leadId, memberId, actorId) => {
  if (!mongoose.Types.ObjectId.isValid(memberId)) throw err(400, "Invalid member id");
  const active = await LeadTeamMemberRepository.findActiveById(memberId);
  if (!active || String(active.leadId) !== String(leadId))
    throw err(404, "Active team member not found on this lead");

  const closed = await LeadTeamMemberRepository.close(memberId, actorId, new Date());

  await LeadInternalEventService.record({
    leadId,
    type: "team_member_removed",
    actorId,
    payload: {
      personId: String(active.personId),
      personName: (await Admin.findById(active.personId, { name: 1 }).lean())?.name || "—",
      departmentId: active.departmentId ? String(active.departmentId) : null,
      departmentName: active.departmentName || "",
    },
  });

  return (await decorate([closed]))[0];
};

// Lead ids the person is CURRENTLY rostered on (the additive "my team" surface).
const myTeamLeadIds = async (personId) => LeadTeamMemberRepository.findActiveLeadIdsByPerson(personId);

module.exports = {
  peopleOptions,
  listRoster,
  addMember,
  removeMember,
  myTeamLeadIds,
  departmentsOfAdmin,
};
