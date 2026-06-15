const LeadTeamMember = require("../models/LeadTeamMember");

// ── MB8a Slice 1 — append-only roster repository ──────────────────────────────
// Add a row, close a row (remove), and read. There are deliberately NO update or
// hard-delete helpers — the roster is append-only history.

const create = async (entry) => {
  return await LeadTeamMember.create(entry);
};

// Full timeline for a lead, oldest-first (the history view reads this).
const findByLead = async (leadId) => {
  return await LeadTeamMember.find({ leadId }).sort({ activeFrom: 1, createdAt: 1 }).lean();
};

// Current team for a lead — rows still active (activeTo null).
const findCurrentByLead = async (leadId) => {
  return await LeadTeamMember.find({ leadId, activeTo: null }).sort({ addedAt: 1 }).lean();
};

// A specific active membership (used for dup-checks and to resolve a remove).
const findActiveById = async (memberId) => {
  return await LeadTeamMember.findOne({ _id: memberId, activeTo: null }).lean();
};

// Is this person already actively serving this department on this lead?
// departmentId may be null (no-department membership) — match that too.
const findActiveMembership = async (leadId, personId, departmentId) => {
  return await LeadTeamMember.findOne({
    leadId,
    personId,
    departmentId: departmentId || null,
    activeTo: null,
  }).lean();
};

// Close an active row: set activeTo + removedBy. The record is retained.
const close = async (memberId, removedBy, when) => {
  return await LeadTeamMember.findOneAndUpdate(
    { _id: memberId, activeTo: null },
    { $set: { activeTo: when || new Date(), removedBy: removedBy || null } },
    { new: true }
  ).lean();
};

// Lead ids this person is CURRENTLY on the team for (the "my leads" surface).
const findActiveLeadIdsByPerson = async (personId) => {
  const rows = await LeadTeamMember.find({ personId, activeTo: null }, { leadId: 1 }).lean();
  return rows.map((r) => r.leadId);
};

// ── MB8c-1 dashboard reads ───────────────────────────────────────────────────
// Distinct lead ids any of these persons are CURRENTLY on the team for.
const findActiveLeadIdsByPersons = async (personIds) => {
  const rows = await LeadTeamMember.find({ personId: { $in: personIds }, activeTo: null }, { leadId: 1 }).lean();
  return [...new Set(rows.map((r) => String(r.leadId)))];
};

// Current members for a set of leads (the pipeline "who's on the team" column).
const findCurrentByLeadIds = async (leadIds) =>
  LeadTeamMember.find({ leadId: { $in: leadIds }, activeTo: null }, { leadId: 1, personId: 1 }).lean();

module.exports = {
  create,
  findByLead,
  findCurrentByLead,
  findActiveById,
  findActiveMembership,
  close,
  findActiveLeadIdsByPerson,
  findActiveLeadIdsByPersons,
  findCurrentByLeadIds,
};
