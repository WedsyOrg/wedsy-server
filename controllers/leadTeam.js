const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const LeadTeamService = require("../services/LeadTeamService");
const LeadTeamMemberRepository = require("../repositories/LeadTeamMemberRepository");

const respond = (res, error) => {
  const status = error.status || 500;
  res.status(status).json({ message: status === 500 ? "Server error" : error.message });
};

// Lead-scope guard (mirrors leadChat): the lead must satisfy the caller's scope
// filter (built by requirePermission with ownerField assignedTo), OR the caller
// must be a CURRENT roster member (Signal Matrix Slice 3 — roster continuity:
// the qualify handoff moves assignedTo to the manager, which used to lock the
// qualifying rep out of their own lead's team with a 403). all-scope → {} → no
// narrowing.
const assertInScope = async (id, scopeFilter = {}, callerId = null) => {
  if (!mongoose.Types.ObjectId.isValid(id))
    throw Object.assign(new Error("Invalid lead id"), { status: 400 });
  const inScope = await Enquiry.findOne({ $and: [{ _id: id }, scopeFilter || {}] }, { _id: 1 }).lean();
  if (inScope) return;
  if (callerId) {
    const roster = await LeadTeamMemberRepository.findCurrentByLead(id);
    if (roster.some((r) => String(r.personId) === String(callerId))) return;
  }
  throw Object.assign(new Error("Out of your scope"), { status: 403 });
};

// GET /enquiry/:_id/team — current roster + full append-only history.
const Get = async (req, res) => {
  try {
    await assertInScope(req.params._id, req.scopeFilter, req.auth.user_id);
    res.status(200).json(await LeadTeamService.listRoster(req.params._id));
  } catch (error) {
    respond(res, error);
  }
};

// GET /enquiry/:_id/team/options — people grouped by department (the add control).
const Options = async (req, res) => {
  try {
    await assertInScope(req.params._id, req.scopeFilter, req.auth.user_id);
    res.status(200).json(await LeadTeamService.peopleOptions());
  } catch (error) {
    respond(res, error);
  }
};

// POST /enquiry/:_id/team — { personId, departmentId? } → add to roster.
const Add = async (req, res) => {
  try {
    await assertInScope(req.params._id, req.scopeFilter, req.auth.user_id);
    const member = await LeadTeamService.addMember(
      req.params._id,
      { personId: req.body?.personId, departmentId: req.body?.departmentId },
      req.auth.user_id
    );
    res.status(201).json(member);
  } catch (error) {
    respond(res, error);
  }
};

// DELETE /enquiry/:_id/team/:memberId — close the active membership (kept in history).
const Remove = async (req, res) => {
  try {
    await assertInScope(req.params._id, req.scopeFilter, req.auth.user_id);
    const member = await LeadTeamService.removeMember(req.params._id, req.params.memberId, req.auth.user_id);
    res.status(200).json(member);
  } catch (error) {
    respond(res, error);
  }
};

// GET /enquiry/team/mine — leads the CALLER is currently rostered on. SOFT,
// ADDITIVE surface (Slice 3): this is deliberately NOT narrowed by the caller's
// ownership scope — being on the roster is itself the (soft) grant, so a member
// sees leads they're on the team for ALONGSIDE their normal access. No 403
// gating is introduced anywhere; requirePermission only confirms the caller is
// an authenticated lead-viewer.
const MyLeads = async (req, res) => {
  try {
    const ids = await LeadTeamService.myTeamLeadIds(req.auth.user_id);
    const list = ids.length
      ? await Enquiry.find({ _id: { $in: ids } }).sort({ updatedAt: -1 }).lean()
      : [];
    res.status(200).json({ list, total: list.length, page: 1, totalPages: 1 });
  } catch (error) {
    respond(res, error);
  }
};

module.exports = { Get, Options, Add, Remove, MyLeads };
