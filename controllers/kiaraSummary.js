const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const KiaraSummaryService = require("../services/KiaraSummaryService");

const respond = (res, error) => {
  const status = error.status || 500;
  res.status(status).json({ message: status === 500 ? "Server error" : error.message });
};

// Enforce lead-scope: the lead must satisfy the caller's scope filter (built by
// requirePermission with ownerField assignedTo). all-scope → {} → no narrowing.
const assertInScope = async (id, scopeFilter = {}) => {
  if (!mongoose.Types.ObjectId.isValid(id)) throw Object.assign(new Error("Invalid enquiry id"), { status: 400 });
  const inScope = await Enquiry.findOne({ $and: [{ _id: id }, scopeFilter || {}] }, { _id: 1 }).lean();
  if (!inScope) throw Object.assign(new Error("Out of your scope"), { status: 403 });
};

// GET /enquiry/:_id/kiara-summary — cached summary (generates on first read).
const Get = async (req, res) => {
  try {
    await assertInScope(req.params._id, req.scopeFilter);
    res.status(200).json(await KiaraSummaryService.getSummary(req.params._id));
  } catch (error) {
    respond(res, error);
  }
};

// POST /enquiry/:_id/kiara-summary — "Regenerate": force a fresh summary.
const Regenerate = async (req, res) => {
  try {
    await assertInScope(req.params._id, req.scopeFilter);
    res.status(200).json(await KiaraSummaryService.getSummary(req.params._id, { force: true }));
  } catch (error) {
    respond(res, error);
  }
};

module.exports = { Get, Regenerate };
