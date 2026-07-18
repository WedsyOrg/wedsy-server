// Qualify-continuity (Slice B1) — the ONE scope-or-roster read guard.
//
// requirePermission builds req.scopeFilter from ownership (assignedTo). The
// qualify handoff moves assignedTo to the manager, so the qualifying rep drops
// out of that scope on their own lead — but they stay on the lead's TEAM
// ROSTER (LeadTeamMember, added at the handoff). READ routes on the lead page
// honour that: in ownership scope OR a current roster member. Writes keep
// their existing owner/manager gating (this helper is for reads; leadTeam's
// routes deliberately use it for roster management too, per Slice 3).
const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const LeadTeamMemberRepository = require("../repositories/LeadTeamMemberRepository");

const err = (status, message) => Object.assign(new Error(message), { status });

// Is this admin CURRENTLY on the lead's roster (activeTo null)?
const isCurrentRosterMember = async (leadId, adminId) => {
  if (!adminId || !mongoose.Types.ObjectId.isValid(String(leadId))) return false;
  const roster = await LeadTeamMemberRepository.findCurrentByLead(leadId);
  return roster.some((r) => String(r.personId) === String(adminId));
};

// The scoped existence check every per-lead controller uses, widened by roster
// membership. Throws 400 (bad id) / 403 (neither in scope nor on the roster).
// C-fix 2 — PARTICIPANT READ GATE. opts.includeParticipants additionally
// admits lane owners and open-task assignees of the lead (per-lead probe via
// ParticipantScopeService). DEFAULT OFF: every existing call site — including
// the write/action ones (roster management, follow-up actions, MOM saves) —
// keeps its exact prior gate; READ handlers opt in explicitly.
const assertInScopeOrRoster = async (
  leadId,
  scopeFilter = {},
  callerId = null,
  { includeParticipants = false } = {}
) => {
  if (!mongoose.Types.ObjectId.isValid(String(leadId))) throw err(400, "Invalid lead id");
  const inScope = await Enquiry.findOne(
    { $and: [{ _id: leadId }, scopeFilter || {}] },
    { _id: 1 }
  ).lean();
  if (inScope) return;
  if (await isCurrentRosterMember(leadId, callerId)) return;
  if (includeParticipants && callerId) {
    const { isParticipantOnLead } = require("../services/ParticipantScopeService");
    if (await isParticipantOnLead(leadId, callerId)) return;
  }
  throw err(403, "Out of your scope");
};

module.exports = { isCurrentRosterMember, assertInScopeOrRoster };
