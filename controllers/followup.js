const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const FollowupService = require("../services/FollowupService");
const { assertInScopeOrRoster } = require("../utils/leadScope");

const respond = (res, error) => {
  const status = error.status || 500;
  if (status === 500) console.error("[followup]", error);
  res.status(status).json({ message: status === 500 ? "Something went wrong with this follow-up — please retry." : error.message });
};

const assertInScope = async (id, scopeFilter = {}) => {
  if (!mongoose.Types.ObjectId.isValid(id)) throw Object.assign(new Error("Invalid lead id"), { status: 400 });
  const inScope = await Enquiry.findOne({ $and: [{ _id: id }, scopeFilter || {}] }, { _id: 1 }).lean();
  if (!inScope) throw Object.assign(new Error("Out of your scope"), { status: 403 });
};

// GET /enquiry/:_id/followups — list (also sweeps the once-only "due" cards).
// READ: roster members allowed (Slice B1); writes below keep the strict scope.
const ListForLead = async (req, res) => {
  try {
    await assertInScopeOrRoster(req.params._id, req.scopeFilter, req.auth.user_id);
    await FollowupService.sweepDueCards(req.params._id);
    res.status(200).json({ list: await FollowupService.listForLead(req.params._id) });
  } catch (error) {
    respond(res, error);
  }
};

// POST /enquiry/:_id/followups — { title, dueAt, ownerId? }
const Create = async (req, res) => {
  try {
    await assertInScope(req.params._id, req.scopeFilter);
    const f = await FollowupService.create(req.params._id, { title: req.body?.title, dueAt: req.body?.dueAt, ownerId: req.body?.ownerId }, req.auth.user_id);
    res.status(201).json(f);
  } catch (error) {
    respond(res, error);
  }
};

// PATCH /enquiry/:_id/followups/:followupId — { action: "done" | "snooze", until? }
const Patch = async (req, res) => {
  try {
    await assertInScope(req.params._id, req.scopeFilter);
    const action = req.body?.action;
    const f = action === "snooze"
      ? await FollowupService.snooze(req.params.followupId, { until: req.body?.until }, req.auth.user_id)
      : await FollowupService.complete(req.params.followupId, req.auth.user_id);
    res.status(200).json(f);
  } catch (error) {
    respond(res, error);
  }
};

// GET /enquiry/followups/mine — caller's open follow-ups due soon.
const Mine = async (req, res) => {
  try {
    res.status(200).json({ list: await FollowupService.myDue(req.auth.user_id, { withinDays: Number(req.query.withinDays) || 2 }) });
  } catch (error) {
    respond(res, error);
  }
};

module.exports = { ListForLead, Create, Patch, Mine };
