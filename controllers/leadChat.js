const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const LeadChatService = require("../services/LeadChatService");

const respond = (res, error) => {
  const status = error.status || 500;
  res.status(status).json({ message: status === 500 ? "Server error" : error.message });
};

// Lead-scope: the lead must satisfy the caller's scope filter (built by
// requirePermission with ownerField assignedTo). all-scope → {} → no narrowing.
const assertInScope = async (id, scopeFilter = {}) => {
  if (!mongoose.Types.ObjectId.isValid(id)) throw Object.assign(new Error("Invalid enquiry id"), { status: 400 });
  const inScope = await Enquiry.findOne({ $and: [{ _id: id }, scopeFilter || {}] }, { _id: 1 }).lean();
  if (!inScope) throw Object.assign(new Error("Out of your scope"), { status: 403 });
};

// GET /enquiry/:_id/chat — paginated thread; marks read for the caller.
const List = async (req, res) => {
  try {
    await assertInScope(req.params._id, req.scopeFilter);
    const result = await LeadChatService.listMessages(req.params._id, req.auth.user_id, {
      limit: req.query.limit,
      before: req.query.before,
    });
    res.status(200).json(result);
  } catch (error) {
    respond(res, error);
  }
};

// POST /enquiry/:_id/chat — { body, attachments, mentions }
const Post = async (req, res) => {
  try {
    await assertInScope(req.params._id, req.scopeFilter);
    const msg = await LeadChatService.postMessage(req.params._id, req.auth.user_id, req.body || {});
    res.status(201).json(msg);
  } catch (error) {
    respond(res, error);
  }
};

// PATCH /enquiry/:_id/chat/:messageId — edit own message
const Edit = async (req, res) => {
  try {
    const msg = await LeadChatService.editMessage(req.params.messageId, req.auth.user_id, req.body || {});
    res.status(200).json(msg);
  } catch (error) {
    respond(res, error);
  }
};

// DELETE /enquiry/:_id/chat/:messageId — delete own message
const Remove = async (req, res) => {
  try {
    const result = await LeadChatService.deleteMessage(req.params.messageId, req.auth.user_id);
    res.status(200).json(result);
  } catch (error) {
    respond(res, error);
  }
};

// GET /enquiry/:_id/chat/members — @mention candidates (scope-aware)
const Members = async (req, res) => {
  try {
    await assertInScope(req.params._id, req.scopeFilter);
    res.status(200).json({ list: await LeadChatService.mentionCandidates() });
  } catch (error) {
    respond(res, error);
  }
};

module.exports = { List, Post, Edit, Remove, Members };
