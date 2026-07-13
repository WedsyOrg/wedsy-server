const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const RescueService = require("../services/RescueService");

const respond = (res, error) => {
  const status = error.status || 500;
  if (status === 500) console.error("[rescue]", error);
  res.status(status).json({ message: status === 500 ? "Something went wrong with this rescue action — please retry." : error.message });
};

const assertInScope = async (id, scopeFilter = {}) => {
  if (!mongoose.Types.ObjectId.isValid(id)) throw Object.assign(new Error("Invalid lead id"), { status: 400 });
  const inScope = await Enquiry.findOne({ $and: [{ _id: id }, scopeFilter || {}] }, { _id: 1 }).lean();
  if (!inScope) throw Object.assign(new Error("Out of your scope"), { status: 403 });
};

// GET /enquiry/rescue-queue — tier-2/3 leads for the manager / Revenue Head
// (scope-aware: team → subordinates' breached leads; all → every breached lead).
const Queue = async (req, res) => {
  try {
    res.status(200).json(await RescueService.rescueQueue(req.auth.user_id, req.scope || "own"));
  } catch (error) {
    respond(res, error);
  }
};

// POST /enquiry/:_id/rescue/claim — ATOMIC first-claim-wins. The caller must be
// in scope (a manager/RevHead over the breached lead). Returns an openCall signal.
const Claim = async (req, res) => {
  try {
    await assertInScope(req.params._id, req.scopeFilter);
    res.status(200).json(await RescueService.claim(req.params._id, req.auth.user_id));
  } catch (error) {
    respond(res, error);
  }
};

// POST /enquiry/:_id/rescue/reassign — { toAdminId }
const Reassign = async (req, res) => {
  try {
    await assertInScope(req.params._id, req.scopeFilter);
    res.status(200).json(await RescueService.reassign(req.params._id, req.body?.toAdminId, req.auth.user_id));
  } catch (error) {
    respond(res, error);
  }
};

// POST /enquiry/:_id/rescue/dismiss
const Dismiss = async (req, res) => {
  try {
    await assertInScope(req.params._id, req.scopeFilter);
    res.status(200).json(await RescueService.dismiss(req.params._id, req.auth.user_id));
  } catch (error) {
    respond(res, error);
  }
};

module.exports = { Queue, Claim, Reassign, Dismiss };
