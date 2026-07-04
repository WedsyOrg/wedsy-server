const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const LeadLane = require("../models/LeadLane");
const LeadLaneService = require("../services/LeadLaneService");
const { assertInScopeOrRoster } = require("../utils/leadScope");

const respond = (res, error) => {
  const status = error.status || 500;
  if (status === 500) console.error("[leadLane]", error);
  res.status(status).json({ message: status === 500 ? "Server error" : error.message });
};

// WRITE guard: the caller's ownership scope must match the lead (owner /
// manager tier), OR — for lane-specific writes — the caller owns THAT lane.
const assertCanWrite = async (leadId, scopeFilter, callerId, laneId = null) => {
  if (!mongoose.Types.ObjectId.isValid(String(leadId)))
    throw Object.assign(new Error("Invalid lead id"), { status: 400 });
  const inScope = await Enquiry.findOne(
    { $and: [{ _id: leadId }, scopeFilter || {}] },
    { _id: 1 }
  ).lean();
  if (inScope) return;
  if (laneId && mongoose.Types.ObjectId.isValid(String(laneId))) {
    const lane = await LeadLane.findOne({ _id: laneId, leadId }, { ownerId: 1 }).lean();
    if (lane && lane.ownerId && String(lane.ownerId) === String(callerId)) return;
  }
  throw Object.assign(new Error("Out of your scope"), { status: 403 });
};

// GET /enquiry/:_id/lanes — lanes + last entries; assembly proposal when none.
// READ: roster members allowed (Slice B1 guard).
const List = async (req, res) => {
  try {
    await assertInScopeOrRoster(req.params._id, req.scopeFilter, req.auth.user_id);
    res.status(200).json(await LeadLaneService.listLanes(req.params._id));
  } catch (error) {
    respond(res, error);
  }
};

// GET /enquiry/:_id/lanes/:laneId/entries — full thread, oldest-first.
// READ: roster members allowed (Slice B1 guard).
const ListEntries = async (req, res) => {
  try {
    await assertInScopeOrRoster(req.params._id, req.scopeFilter, req.auth.user_id);
    res.status(200).json(await LeadLaneService.listEntries(req.params._id, req.params.laneId, { limit: req.query.limit }));
  } catch (error) {
    respond(res, error);
  }
};

// POST /enquiry/:_id/lanes/assemble — { lanes: [{key,name,ownerId,state,wake?}] }
const Assemble = async (req, res) => {
  try {
    await assertCanWrite(req.params._id, req.scopeFilter, req.auth.user_id);
    res.status(201).json(await LeadLaneService.assemble(req.params._id, req.body || {}, req.auth.user_id));
  } catch (error) {
    respond(res, error);
  }
};

// POST /enquiry/:_id/lanes — add one lane later.
const Add = async (req, res) => {
  try {
    await assertCanWrite(req.params._id, req.scopeFilter, req.auth.user_id);
    res.status(201).json(await LeadLaneService.addLane(req.params._id, req.body || {}, req.auth.user_id));
  } catch (error) {
    respond(res, error);
  }
};

// PATCH /enquiry/:_id/lanes/:laneId — { ownerId?, state?, wake?, pausedReason? }
const Patch = async (req, res) => {
  try {
    await assertCanWrite(req.params._id, req.scopeFilter, req.auth.user_id, req.params.laneId);
    res.status(200).json(await LeadLaneService.patchLane(req.params._id, req.params.laneId, req.body || {}, req.auth.user_id));
  } catch (error) {
    respond(res, error);
  }
};

// POST /enquiry/:_id/lanes/:laneId/entries — { text }
const AddEntry = async (req, res) => {
  try {
    await assertCanWrite(req.params._id, req.scopeFilter, req.auth.user_id, req.params.laneId);
    res.status(201).json(await LeadLaneService.addEntry(req.params._id, req.params.laneId, req.body || {}, req.auth.user_id));
  } catch (error) {
    respond(res, error);
  }
};

module.exports = { List, ListEntries, Assemble, Add, Patch, AddEntry };
