const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const LeadLane = require("../models/LeadLane");
const LeadLaneService = require("../services/LeadLaneService");
const { assertInScopeOrRoster } = require("../utils/leadScope");

const respond = (res, error) => {
  const status = error.status || 500;
  if (status === 500) console.error("[leadLane]", error);
  res.status(status).json({ message: status === 500 ? "Something went wrong with this lane — please retry." : error.message });
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
// Baseline ensure (lazy hook): every QUALIFIED, non-lost lead gets the
// baseline lane set on first read — covers historic leads with no migration
// and every qualify path without touching them. Idempotent (assemble skips
// existing keys) and fire-safe: an ensure failure never breaks the read.
const List = async (req, res) => {
  try {
    await assertInScopeOrRoster(req.params._id, req.scopeFilter, req.auth.user_id, { includeParticipants: true });
    try {
      const { isTerminalLost } = require("../utils/lostTerminal");
      const lead = await Enquiry.findById(
        req.params._id,
        { qualifiedAt: 1, stage: 1, isLost: 1, lostStatus: 1 }
      ).lean();
      if (lead && lead.qualifiedAt && !isTerminalLost(lead)) {
        await LeadLaneService.ensureBaselineLanes(req.params._id, req.auth.user_id);
      }
    } catch (e) {
      console.error("[leadLane] baseline ensure failed:", e.message);
    }
    res.status(200).json(await LeadLaneService.listLanes(req.params._id));
  } catch (error) {
    respond(res, error);
  }
};

// GET /enquiry/:_id/lanes/:laneId/entries — full thread, oldest-first.
// READ: roster members allowed (Slice B1 guard).
const ListEntries = async (req, res) => {
  try {
    await assertInScopeOrRoster(req.params._id, req.scopeFilter, req.auth.user_id, { includeParticipants: true });
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

// ── Journey v2 (V3) — per-lane money ─────────────────────────────────────────
// scopeOk (lead owner/manager) is computed HERE from req.scopeFilter and passed
// down: propose = lane owner OR scopeOk; confirm = scopeOk ONLY.
const scopeCovers = async (leadId, scopeFilter) =>
  !!(await Enquiry.findOne({ $and: [{ _id: leadId }, scopeFilter || {}] }, { _id: 1 }).lean());

// PUT /enquiry/:_id/lanes/:laneId/price { amount }
const ProposePrice = async (req, res) => {
  try {
    const scopeOk = await scopeCovers(req.params._id, req.scopeFilter);
    const result = await LeadLaneService.proposePrice(
      req.params._id,
      req.params.laneId,
      req.body && req.body.amount,
      req.auth.user_id,
      scopeOk
    );
    res.status(200).json(result);
  } catch (error) {
    respond(res, error);
  }
};

// PUT /enquiry/:_id/lanes/:laneId/price/confirm
const ConfirmPrice = async (req, res) => {
  try {
    const scopeOk = await scopeCovers(req.params._id, req.scopeFilter);
    const result = await LeadLaneService.confirmPrice(
      req.params._id,
      req.params.laneId,
      req.auth.user_id,
      scopeOk
    );
    res.status(200).json(result);
  } catch (error) {
    respond(res, error);
  }
};

// ── Journey v2 (V5) — the engagement pulse ────────────────────────────────────
// POST /enquiry/:_id/lanes/:laneId/engagement-sent { itemId }
const EngagementSent = async (req, res) => {
  try {
    const scopeOk = await scopeCovers(req.params._id, req.scopeFilter);
    const result = await LeadLaneService.markEngagementSent(
      req.params._id,
      req.params.laneId,
      req.body && req.body.itemId,
      req.auth.user_id,
      scopeOk
    );
    res.status(201).json(result);
  } catch (error) {
    respond(res, error);
  }
};

// GET /enquiry/:_id/lanes/:laneId/engagement-log — roster-aware read.
const EngagementLog = async (req, res) => {
  try {
    await assertInScopeOrRoster(req.params._id, req.scopeFilter, req.auth.user_id, { includeParticipants: true });
    res.status(200).json({ log: await LeadLaneService.engagementLog(req.params._id, req.params.laneId) });
  } catch (error) {
    respond(res, error);
  }
};

// GET /enquiry/:_id/lanes/:laneId/engagement-items — the ACTIVE library for the
// people who send it: lead scope/roster OR the lane's own owner (a lane owner
// outside the lead's roster must still see what they can send).
const EngagementItems = async (req, res) => {
  try {
    try {
      await assertInScopeOrRoster(req.params._id, req.scopeFilter, req.auth.user_id, { includeParticipants: true });
    } catch (scopeErr) {
      const lane = await LeadLane.findOne(
        { _id: req.params.laneId, leadId: req.params._id },
        { ownerId: 1 }
      ).lean();
      const isLaneOwner = lane && lane.ownerId && String(lane.ownerId) === String(req.auth.user_id);
      if (!isLaneOwner) throw scopeErr;
    }
    res.status(200).json({ items: await LeadLaneService.engagementItems(req.params._id, req.params.laneId) });
  } catch (error) {
    respond(res, error);
  }
};

// C3 — POST /:_id/lanes/:laneId/nudge (lane owner / lead owner / roster).
const Nudge = async (req, res) => {
  try {
    const out = await LeadLaneService.nudge(req.params._id, req.params.laneId, req.auth.user_id);
    res.status(200).json(out);
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ message: status === 500 ? "Could not nudge — please retry." : error.message });
  }
};

module.exports = { List, ListEntries, Assemble, Add, Patch, AddEntry, ProposePrice, ConfirmPrice, EngagementSent, EngagementLog, EngagementItems, Nudge };
