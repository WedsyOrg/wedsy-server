const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const GoldenWindowService = require("../services/GoldenWindowService");

const respond = (res, error) => {
  const status = error.status || 500;
  if (status === 500) console.error("[goldenWindow]", error);
  res.status(status).json({ message: status === 500 ? "Server error" : error.message });
};

const assertInScope = async (id, scopeFilter = {}) => {
  if (!mongoose.Types.ObjectId.isValid(id)) throw Object.assign(new Error("Invalid lead id"), { status: 400 });
  const inScope = await Enquiry.findOne({ $and: [{ _id: id }, scopeFilter || {}] }, { _id: 1 }).lean();
  if (!inScope) throw Object.assign(new Error("Out of your scope"), { status: 403 });
};

// GET /enquiry/:_id/golden-window — the lead's live clock (the pre-qual hero).
const LeadClock = async (req, res) => {
  try {
    await assertInScope(req.params._id, req.scopeFilter);
    res.status(200).json(await GoldenWindowService.leadClock(req.params._id));
  } catch (error) {
    respond(res, error);
  }
};

// GET /enquiry/respond-now — the caller's uncontacted, urgency-sorted queue.
const RespondNow = async (req, res) => {
  try {
    res.status(200).json(await GoldenWindowService.respondNow(req.auth.user_id));
  } catch (error) {
    respond(res, error);
  }
};

// GET /enquiry/golden-window/metrics?periodDays=7 — scope-aware SLA metrics.
const Metrics = async (req, res) => {
  try {
    res.status(200).json(
      await GoldenWindowService.metrics(req.auth.user_id, req.scope || "own", { periodDays: Number(req.query.periodDays) || 7 })
    );
  } catch (error) {
    respond(res, error);
  }
};

module.exports = { LeadClock, RespondNow, Metrics };
