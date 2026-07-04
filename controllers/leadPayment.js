const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const LeadLane = require("../models/LeadLane");
const LeadPaymentService = require("../services/LeadPaymentService");
const { assertInScopeOrRoster } = require("../utils/leadScope");

const respond = (res, error) => {
  const status = error.status || 500;
  if (status === 500) console.error("[leadPayment]", error);
  res.status(status).json({ message: status === 500 ? "Server error" : error.message });
};

// WRITE guard (mirrors leadLane): ownership scope OR the caller owns ANY lane
// on this lead (a lane owner records payments for their workstream).
const assertCanWrite = async (leadId, scopeFilter, callerId) => {
  if (!mongoose.Types.ObjectId.isValid(String(leadId)))
    throw Object.assign(new Error("Invalid lead id"), { status: 400 });
  const inScope = await Enquiry.findOne({ $and: [{ _id: leadId }, scopeFilter || {}] }, { _id: 1 }).lean();
  if (inScope) return;
  const ownLane = await LeadLane.exists({ leadId, ownerId: callerId });
  if (ownLane) return;
  throw Object.assign(new Error("Out of your scope"), { status: 403 });
};

// GET /enquiry/:_id/payments — ledger + { total, received, balance }.
const List = async (req, res) => {
  try {
    await assertInScopeOrRoster(req.params._id, req.scopeFilter, req.auth.user_id);
    res.status(200).json(await LeadPaymentService.listForLead(req.params._id));
  } catch (error) {
    respond(res, error);
  }
};

// POST /enquiry/:_id/payments — { amount, mode?, proofUrl?, receivedAt?, note? }
const Create = async (req, res) => {
  try {
    await assertCanWrite(req.params._id, req.scopeFilter, req.auth.user_id);
    res.status(201).json(await LeadPaymentService.record(req.params._id, req.body || {}, req.auth.user_id));
  } catch (error) {
    respond(res, error);
  }
};

// DELETE /enquiry/:_id/payments/:paymentId — founder tier (route: leads:delete:all).
const Remove = async (req, res) => {
  try {
    res.status(200).json(await LeadPaymentService.remove(req.params._id, req.params.paymentId));
  } catch (error) {
    respond(res, error);
  }
};

module.exports = { List, Create, Remove };
