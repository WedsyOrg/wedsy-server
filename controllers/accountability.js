const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const AccountabilityService = require("../services/AccountabilityService");
const { assertInScopeOrRoster } = require("../utils/leadScope");

const respond = (res, error) => {
  const status = error.status || 500;
  if (status === 500) console.error("[accountability]", error);
  res.status(status).json({ message: status === 500 ? "Something went wrong loading accountability data — please retry." : error.message });
};

const assertInScope = async (id, scopeFilter = {}) => {
  if (!mongoose.Types.ObjectId.isValid(id)) throw Object.assign(new Error("Invalid lead id"), { status: 400 });
  const inScope = await Enquiry.findOne({ $and: [{ _id: id }, scopeFilter || {}] }, { _id: 1 }).lean();
  if (!inScope) throw Object.assign(new Error("Out of your scope"), { status: 403 });
};

// GET /enquiry/:_id/accountability — the ONE rule, for the command-center banner.
// Per-viewer framing is decided client-side from mostUrgent.responsibleId vs me.
const Assess = async (req, res) => {
  try {
    await assertInScopeOrRoster(req.params._id, req.scopeFilter, req.auth.user_id, { includeParticipants: true }); // READ (Slice B1)
    res.status(200).json(await AccountabilityService.assessLead(req.params._id));
  } catch (error) {
    respond(res, error);
  }
};

// POST /enquiry/:_id/accountability/nudge — { responsibleId, stepName?, message? }
const Nudge = async (req, res) => {
  try {
    await assertInScope(req.params._id, req.scopeFilter);
    const r = await AccountabilityService.nudge(
      req.params._id,
      { responsibleId: req.body?.responsibleId, stepName: req.body?.stepName, message: req.body?.message },
      req.auth.user_id
    );
    res.status(200).json(r);
  } catch (error) {
    respond(res, error);
  }
};

module.exports = { Assess, Nudge };
