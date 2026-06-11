const DashboardService = require("../services/DashboardService");
const LeadLifecycleService = require("../services/LeadLifecycleService");
const ProjectService = require("../services/ProjectService");

const respondError = (res, error) => {
  const status = error.status || 500;
  const message = status === 500 ? "Server error" : error.message;
  if (status === 500) console.error("[lifecycle]", error);
  res.status(status).json({ message });
};

// GET /enquiry/dashboard — the role-aware morning briefing. Every query inside is
// bounded to the caller's effective scope (req.scope/req.scopeFilter from
// requirePermission("leads:view:own", { ownerField: "assignedTo" })).
const Dashboard = async (req, res) => {
  try {
    const payload = await DashboardService.buildDashboard(
      req.auth.user_id,
      req.scope,
      req.scopeFilter || {}
    );
    res.status(200).json(payload);
  } catch (error) {
    respondError(res, error);
  }
};

// PUT /enquiry/:_id/follow-up/:followUpId/complete — the zero-orphan gate lives
// in LeadLifecycleService (422 when an open lead would exit into nothing).
const CompleteFollowUp = async (req, res) => {
  try {
    const result = await LeadLifecycleService.completeFollowUp(
      req.params._id,
      req.params.followUpId,
      req.body,
      req.auth.user_id
    );
    res.status(200).json(result);
  } catch (error) {
    respondError(res, error);
  }
};

// POST /enquiry/:_id/recycle
const Recycle = async (req, res) => {
  try {
    const updated = await LeadLifecycleService.recycleLead(
      req.params._id,
      req.body,
      req.auth.user_id
    );
    res.status(200).json(updated);
  } catch (error) {
    respondError(res, error);
  }
};

// POST /enquiry/:_id/convert — Meeting Scheduled → Project (terminal "won").
const Convert = async (req, res) => {
  try {
    const project = await ProjectService.convertLead(
      req.params._id,
      req.body,
      req.auth.user_id
    );
    res.status(201).json(project);
  } catch (error) {
    respondError(res, error);
  }
};

module.exports = { Dashboard, CompleteFollowUp, Recycle, Convert };
