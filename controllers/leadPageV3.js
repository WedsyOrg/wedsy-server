// LEAD-PAGE v3 controllers — activity (L1), milestones (L2), the money face
// (L3), quote requests (L4), the client-tasks proxy (L5).
const mongoose = require("mongoose");
const LeadActivityService = require("../services/LeadActivityService");
const PaymentMilestoneService = require("../services/PaymentMilestoneService");
const MoneyFaceService = require("../services/MoneyFaceService");
const QuoteRequestService = require("../services/QuoteRequestService");
const { assertInScopeOrRoster } = require("../utils/leadScope");

const respond = (res, error, fallback) => {
  const status = error.status || 500;
  if (status === 500) console.error("[leadPageV3]", error);
  res.status(status).json({ message: status === 500 ? fallback : error.message });
};

// ── L1 ────────────────────────────────────────────────────────────────────────
// POST /activity/ingest — internal seam (shared secret) or admin JWT.
const IngestActivity = async (req, res) => {
  try {
    const event = await LeadActivityService.ingest(req.body || {}, {
      adminId: req.auth && req.auth.user_id ? req.auth.user_id : null,
    });
    res.status(201).json({ event });
  } catch (error) {
    respond(res, error, "Could not record the activity — please retry.");
  }
};

// GET /enquiry/:_id/activity?voice=couple|wedsy|all&limit — participant read.
const ListActivity = async (req, res) => {
  try {
    await assertInScopeOrRoster(req.params._id, req.scopeFilter, req.auth.user_id, { includeParticipants: true });
    const voice = req.query.voice === "all" ? undefined : req.query.voice;
    res.status(200).json(await LeadActivityService.list(req.params._id, { voice, limit: req.query.limit }));
  } catch (error) {
    respond(res, error, "Could not load the activity feed — please retry.");
  }
};

// ── L2 ────────────────────────────────────────────────────────────────────────
const ListMilestones = async (req, res) => {
  try {
    await assertInScopeOrRoster(req.params._id, req.scopeFilter, req.auth.user_id, { includeParticipants: true });
    res.status(200).json({ schedule: await PaymentMilestoneService.listForLead(req.params._id) });
  } catch (error) {
    respond(res, error, "Could not load the schedule — please retry.");
  }
};
const CreateMilestone = async (req, res) => {
  try {
    res.status(201).json(await PaymentMilestoneService.create(req.params._id, req.body || {}, req.auth.user_id));
  } catch (error) {
    respond(res, error, "Could not create the milestone — please retry.");
  }
};
const PatchMilestone = async (req, res) => {
  try {
    res.status(200).json(await PaymentMilestoneService.patch(req.params._id, req.params.milestoneId, req.body || {}));
  } catch (error) {
    respond(res, error, "Could not update the milestone — please retry.");
  }
};
const DeleteMilestone = async (req, res) => {
  try {
    res.status(200).json(await PaymentMilestoneService.remove(req.params._id, req.params.milestoneId));
  } catch (error) {
    respond(res, error, "Could not delete the milestone — please retry.");
  }
};

// ── L3 ────────────────────────────────────────────────────────────────────────
// GET /enquiry/:_id/money — the dealValue gate: manager+ scope only (own-scope
// callers never see money, mirroring the list's dealValue trim).
const MoneyFace = async (req, res) => {
  try {
    if (!req.scope || req.scope === "own") {
      return res.status(403).json({ message: "The money face is a manager surface." });
    }
    res.status(200).json(await MoneyFaceService.moneyFace(req.params._id));
  } catch (error) {
    respond(res, error, "Could not load the money face — please retry.");
  }
};

// ── L4 ────────────────────────────────────────────────────────────────────────
const IngestQuoteRequest = async (req, res) => {
  try {
    res.status(201).json({ request: await QuoteRequestService.ingest(req.body || {}) });
  } catch (error) {
    respond(res, error, "Could not record the quote request — please retry.");
  }
};
const ListLeadQuoteRequests = async (req, res) => {
  try {
    await assertInScopeOrRoster(req.params._id, req.scopeFilter, req.auth.user_id, { includeParticipants: true });
    res.status(200).json(await QuoteRequestService.listForLead(req.params._id, { status: req.query.status }));
  } catch (error) {
    respond(res, error, "Could not load quote requests — please retry.");
  }
};
const QuoteQueue = async (req, res) => {
  try {
    res.status(200).json(await QuoteRequestService.listQueue({ status: req.query.status, limit: req.query.limit }));
  } catch (error) {
    respond(res, error, "Could not load the quote queue — please retry.");
  }
};
const PatchQuoteRequest = async (req, res) => {
  try {
    res.status(200).json({ request: await QuoteRequestService.patchStatus(req.params.id, req.body && req.body.status, req.auth.user_id) });
  } catch (error) {
    respond(res, error, "Could not update the quote request — please retry.");
  }
};

// ── L5 ────────────────────────────────────────────────────────────────────────
// GET/PUT /enquiry/:_id/client-tasks — the couple's wedding-timeline milestones
// (WeddingMilestone via the Onboarding leadId→eventId bridge). PUT toggles ONE
// milestone's status on the couple's behalf (owner/manager write).
const clientTaskEventId = async (leadId) => {
  const Onboarding = require("../models/Onboarding");
  const ob = await Onboarding.findOne({ leadId, eventId: { $ne: null } }).sort({ createdAt: -1 }).lean();
  return ob ? ob.eventId : null;
};
const ListClientTasks = async (req, res) => {
  try {
    await assertInScopeOrRoster(req.params._id, req.scopeFilter, req.auth.user_id, { includeParticipants: true });
    const eventId = await clientTaskEventId(req.params._id);
    if (!eventId) return res.status(200).json({ eventId: null, tasks: [] });
    const WeddingMilestone = require("../models/WeddingMilestone");
    const tasks = await WeddingMilestone.find({ eventId }).sort({ dueDate: 1 }).lean();
    res.status(200).json({ eventId: String(eventId), tasks });
  } catch (error) {
    respond(res, error, "Could not load the couple's tasks — please retry.");
  }
};
const PutClientTask = async (req, res) => {
  try {
    const { milestoneId, status } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(String(milestoneId || ""))) {
      return res.status(400).json({ message: "Pass a milestoneId." });
    }
    const eventId = await clientTaskEventId(req.params._id);
    if (!eventId) return res.status(404).json({ message: "No linked wedding event for this lead yet." });
    const WeddingMilestone = require("../models/WeddingMilestone");
    const milestone = await WeddingMilestone.findById(milestoneId).lean();
    if (!milestone || String(milestone.eventId) !== String(eventId)) {
      return res.status(404).json({ message: "That task is not on this lead's timeline." });
    }
    const WeddingTimelineService = require("../services/WeddingTimelineService");
    const updated = await WeddingTimelineService.updateMilestone(milestoneId, req.auth.user_id, true, { status });
    // Activity spine — an on-behalf task touch (wedsy voice).
    await LeadActivityService.ingest(
      { leadId: req.params._id, kind: "task", meta: { title: milestone.title, status }, voice: "wedsy" },
      { adminId: req.auth.user_id }
    ).catch(() => {});
    res.status(200).json({ task: updated });
  } catch (error) {
    respond(res, error, "Could not update the couple's task — please retry.");
  }
};

module.exports = {
  IngestActivity, ListActivity,
  ListMilestones, CreateMilestone, PatchMilestone, DeleteMilestone,
  MoneyFace,
  IngestQuoteRequest, ListLeadQuoteRequests, QuoteQueue, PatchQuoteRequest,
  ListClientTasks, PutClientTask,
};
